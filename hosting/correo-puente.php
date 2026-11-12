<?php
/* =====================================================================================
 * correo-puente.php — conector de la casilla de Rosaint (Ferozo) que corre EN EL HOSTING.
 *
 * Por qué existe: Ferozo bloquea las conexiones IMAP que llegan desde Supabase (corta apenas
 * se abre el TLS: "ClosedAfterConnectTLS", visto el 27/10 y otra vez el 12/11/2026). Este
 * archivo vive en el hosting de Rosaint (mismo servidor que el correo) y hace el trabajo con
 * la casilla. El Core NO lo llama directo: lo llama la función `correo` de Supabase, que
 * controla quién entra y le pasa la casilla y la contraseña (guardadas como secretos allá).
 *
 * Seguridad:
 *  - Solo responde a POST con el encabezado X-Puente-Token. Acá se guarda el HASH del token,
 *    no el token (el token está solo en Supabase, secreto CORREO_PUENTE_TOKEN).
 *  - El servidor de correo está fijo acá (no se acepta otro desde afuera).
 *  - No guarda nada en disco. Nunca devuelve la contraseña ni la escribe en errores.
 *
 * Acciones (campo "accion" del JSON):
 *  estado · carpetas · buscar · leer · adjunto · marcar · mover · copiar · borrar
 *  crear_carpeta · renombrar_carpeta · borrar_carpeta · enviar · guardar_borrador
 * Ver la descripción de cada una en la función `atender()` más abajo.
 * Escrito para PHP 7.4+ (sin sintaxis de PHP 8) por si el hosting tiene una versión vieja.
 * ===================================================================================== */

const PUENTE_TOKEN_SHA256 = '0f58c07c957c34840a52d777ce7b27a55e1f42772844e3fd28c7c13e30b5356c';
const IMAP_HOST = 'c229.ferozo.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'c229.ferozo.com';
const SMTP_PORT = 465;
const DOMINIO_MSGID = 'rosaint.com.ar';


/* ------------------------------------------------------------------ entrada HTTP */
function servir() {
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  header('X-Robots-Tag: noindex');
  if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') { http_response_code(405); echo '{"ok":false,"error":"solo POST"}'; return; }
  $tok = $_SERVER['HTTP_X_PUENTE_TOKEN'] ?? '';
  if (strlen(PUENTE_TOKEN_SHA256) !== 64 || $tok === '' || !hash_equals(PUENTE_TOKEN_SHA256, hash('sha256', $tok))) {
    http_response_code(401); echo '{"ok":false,"error":"No autorizado"}'; return;
  }
  @set_time_limit(120);
  @ini_set('memory_limit', '512M');
  $body = json_decode(file_get_contents('php://input'), true);
  if (!is_array($body)) { http_response_code(400); echo '{"ok":false,"error":"JSON inválido"}'; return; }
  $clave = (string)($body['cred']['clave'] ?? '');
  try {
    $r = atender($body);
    echo json_encode($r, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
  } catch (Throwable $e) {
    $msg = $e->getMessage();
    if ($clave !== '') $msg = str_replace($clave, '***', $msg);   // por las dudas: nunca devolver la contraseña
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
  }
}

/* ------------------------------------------------------------------ acciones */
function atender(array $b) {
  $accion = (string)($b['accion'] ?? '');
  $usuario = trim((string)($b['cred']['usuario'] ?? ''));
  $clave = (string)($b['cred']['clave'] ?? '');
  if ($usuario === '' || $clave === '') throw new Exception('Faltan la casilla o la contraseña');
  $carpeta = (string)($b['carpeta'] ?? 'INBOX');

  // enviar: primero se manda por SMTP y después se guarda la copia en Enviados por IMAP
  $imap = new Imap();
  $imap->conectar(IMAP_HOST, IMAP_PORT);
  try {
    $imap->login($usuario, $clave);
    switch ($accion) {

      // estado → casilla, capacidades del servidor, carpetas especiales
      case 'estado':
        return ['ok' => true, 'casilla' => $usuario, 'php' => PHP_VERSION, 'mbstring' => function_exists('mb_convert_encoding'),
          'post_max_size' => ini_get('post_max_size'), 'memory_limit' => ini_get('memory_limit'),
          'capacidades' => $imap->capacidades, 'especiales' => $imap->especiales()];

      // carpetas {conteos?} → [{ruta, nombre, padre, especial, total?, sin_leer?}]
      case 'carpetas':
        return ['ok' => true, 'separador' => $imap->separador(), 'carpetas' => $imap->carpetas(!empty($b['conteos']))];

      // buscar {carpeta, desde?, hasta?, de?, para?, asunto?, texto?, sin_leer?, destacados?, desde_uid?, limite?, pagina?}
      //   → correos del más nuevo al más viejo (solo encabezados)
      case 'buscar': {
        $imap->abrir($carpeta, true);
        $uids = $imap->buscar($b);
        rsort($uids, SORT_NUMERIC);
        $limite = max(1, min(500, (int)($b['limite'] ?? 50)));
        $pagina = max(1, (int)($b['pagina'] ?? 1));
        $elegidos = array_slice($uids, ($pagina - 1) * $limite, $limite);
        return ['ok' => true, 'carpeta' => $carpeta, 'encontrados' => count($uids), 'pagina' => $pagina,
          'uid_validez' => $imap->uidValidez, 'uid_siguiente' => $imap->uidSiguiente, 'correos' => $imap->resumenes($elegidos)];
      }

      // leer {carpeta, uid, marcar_leido?} → texto, html, adjuntos (sin el contenido), encabezados
      case 'leer': {
        $uid = (int)($b['uid'] ?? 0); if (!$uid) throw new Exception('Falta uid');
        $imap->abrir($carpeta, empty($b['marcar_leido']));
        $raw = $imap->crudo($uid);
        if ($raw === null) throw new Exception('No existe ese correo');
        $m = Mime::parsear($raw);
        if (!empty($b['marcar_leido'])) $imap->marcar([$uid], ['\\Seen'], []);
        $out = Mime::resumen($m);
        $out['ok'] = true; $out['uid'] = $uid; $out['carpeta'] = $carpeta; $out['tamano'] = strlen($raw);
        return $out;
      }

      // adjunto {carpeta, uid, parte} → {nombre, tipo, tamano, base64}
      case 'adjunto': {
        $uid = (int)($b['uid'] ?? 0); $parte = (string)($b['parte'] ?? '');
        if (!$uid || $parte === '') throw new Exception('Falta uid o parte');
        $imap->abrir($carpeta, true);
        $raw = $imap->crudo($uid);
        if ($raw === null) throw new Exception('No existe ese correo');
        $p = Mime::buscarParte(Mime::parsear($raw), $parte);
        if (!$p) throw new Exception('Ese correo no tiene la parte ' . $parte);
        $datos = $p['es_mensaje'] ? $p['cuerpo_crudo'] : $p['datos'];
        return ['ok' => true, 'nombre' => $p['nombre'] ?: ('adjunto-' . $parte), 'tipo' => $p['tipo'], 'tamano' => strlen($datos), 'base64' => base64_encode($datos)];
      }

      // marcar {carpeta, uids, leido?, destacado?, respondido?, agregar?:[flags], quitar?:[flags]}
      case 'marcar': {
        $uids = listaUids($b);
        $mas = []; $menos = [];
        foreach (['leido' => '\\Seen', 'destacado' => '\\Flagged', 'respondido' => '\\Answered'] as $k => $f) {
          if (array_key_exists($k, $b) && $b[$k] !== null) { if ($b[$k]) $mas[] = $f; else $menos[] = $f; }
        }
        foreach ((array)($b['agregar'] ?? []) as $f) $mas[] = (string)$f;
        foreach ((array)($b['quitar'] ?? []) as $f) $menos[] = (string)$f;
        if (!$mas && !$menos) throw new Exception('No se indicó qué marcar');
        $imap->abrir($carpeta, false);
        $imap->marcar($uids, $mas, $menos);
        return ['ok' => true, 'marcados' => count($uids)];
      }

      // mover / copiar {carpeta, uids, destino}
      case 'mover':
      case 'copiar': {
        $uids = listaUids($b);
        $destino = (string)($b['destino'] ?? ''); if ($destino === '') throw new Exception('Falta la carpeta destino');
        if ($destino === $carpeta) throw new Exception('El destino es la misma carpeta');
        $imap->existeCarpeta($destino);
        $imap->abrir($carpeta, $accion === 'copiar');
        $nuevos = $accion === 'mover' ? $imap->mover($uids, $destino) : $imap->copiar($uids, $destino);
        return ['ok' => true, 'cantidad' => count($uids), 'destino' => $destino, 'uids_nuevos' => $nuevos];
      }

      // borrar {carpeta, uids, definitivo?}
      //   sin "definitivo": lo pasa a la Papelera (se puede recuperar). Si ya está en la Papelera,
      //   hace falta definitivo:true para borrarlo de verdad.
      case 'borrar': {
        $uids = listaUids($b);
        $papelera = $imap->especial('\\Trash');
        $definitivo = !empty($b['definitivo']);
        if (!$definitivo) {
          if (!$papelera) throw new Exception('La casilla no tiene Papelera: para borrar sin vuelta atrás mandar definitivo:true');
          if ($papelera === $carpeta) throw new Exception('Ya están en la Papelera: para borrarlos de verdad mandar definitivo:true');
          $imap->abrir($carpeta, false);
          $nuevos = $imap->mover($uids, $papelera);
          return ['ok' => true, 'cantidad' => count($uids), 'a_papelera' => $papelera, 'uids_en_papelera' => $nuevos];
        }
        $imap->abrir($carpeta, false);
        $imap->borrarDefinitivo($uids);
        return ['ok' => true, 'cantidad' => count($uids), 'definitivo' => true];
      }

      // crear_carpeta {nombre, padre?}  (padre = ruta completa, ej. "INBOX.@Proveedores")
      case 'crear_carpeta': {
        $nombre = trim((string)($b['nombre'] ?? '')); if ($nombre === '') throw new Exception('Falta el nombre');
        $sep = $imap->separador();
        if ($sep !== '' && strpos($nombre, $sep) !== false) throw new Exception('El nombre no puede tener "' . $sep . '" (usar "padre" para subcarpetas)');
        $padre = trim((string)($b['padre'] ?? ''));
        if ($padre !== '') $imap->existeCarpeta($padre);
        $ruta = $padre !== '' ? $padre . $sep . $nombre : $nombre;
        $imap->crearCarpeta($ruta);
        return ['ok' => true, 'ruta' => $ruta];
      }

      // renombrar_carpeta {carpeta, nuevo}  (nuevo = ruta completa nueva; sirve también para moverla de lugar)
      case 'renombrar_carpeta': {
        $nuevo = trim((string)($b['nuevo'] ?? '')); if ($nuevo === '') throw new Exception('Falta el nombre nuevo');
        if (strtoupper($carpeta) === 'INBOX') throw new Exception('La Bandeja de entrada no se renombra');
        $imap->existeCarpeta($carpeta);
        $imap->renombrarCarpeta($carpeta, $nuevo);
        return ['ok' => true, 'ruta' => $nuevo];
      }

      // borrar_carpeta {carpeta, forzar?}  sin forzar, solo si está vacía y no tiene subcarpetas
      case 'borrar_carpeta': {
        if (strtoupper($carpeta) === 'INBOX') throw new Exception('La Bandeja de entrada no se borra');
        foreach ($imap->especiales() as $esp => $ruta) if ($ruta === $carpeta) throw new Exception('No se borra una carpeta del sistema (' . $esp . ')');
        $imap->existeCarpeta($carpeta);
        $hijas = array_filter($imap->carpetas(false), function ($c) use ($carpeta) { return $c['padre'] === $carpeta; });
        $total = $imap->total($carpeta);
        if (($total > 0 || $hijas) && empty($b['forzar']))
          throw new Exception('La carpeta tiene ' . $total . ' correos y ' . count($hijas) . ' subcarpetas: para borrarla igual mandar forzar:true');
        $imap->borrarCarpeta($carpeta);
        return ['ok' => true, 'borrada' => $carpeta, 'correos_que_tenia' => $total];
      }

      // remitentes {carpeta?, aprender?} → la carpeta agrupada por remitente (para ordenar eligiendo).
      //   aprender: además, por cada remitente, en qué carpetas propias ya hay correos suyos
      //   (así se sugiere el destino según cómo se ordenó antes).
      case 'remitentes': {
        $imap->abrir($carpeta, true);
        $uids = $imap->buscar([]);
        $grupos = [];
        foreach ($imap->encabezadosVarios($uids, ['FROM', 'SUBJECT', 'DATE']) as $uid => $x) {
          $de = Mime::decodificarEncabezado($x['h']['from'] ?? '');
          $l = Direcciones::listaSegura($de);
          $email = $l ? strtolower($l[0]['email']) : (_primerEmail($de) ?: '(sin remitente)');
          if (!isset($grupos[$email])) $grupos[$email] = ['email' => $email, 'nombre' => $l ? $l[0]['nombre'] : '', 'n' => 0, 'sin_leer' => 0, 'ultimo' => 0, 'asuntos' => []];
          $g = &$grupos[$email];
          $g['n']++;
          if (!in_array('\\seen', array_map('strtolower', $x['flags']), true)) $g['sin_leer']++;
          $t = isset($x['h']['date']) ? (int)fechaCorreo($x['h']['date']) : 0;
          if ($t >= $g['ultimo']) { $g['ultimo'] = $t; if ($l && $l[0]['nombre'] !== '') $g['nombre'] = $l[0]['nombre']; }
          $g['asuntos'][] = [$t, mb_substr(Mime::decodificarEncabezado($x['h']['subject'] ?? ''), 0, 90)];
          unset($g);
        }
        foreach ($grupos as &$g) {   // los 3 asuntos más nuevos, para reconocer de qué se trata
          usort($g['asuntos'], function ($a, $b) { return $b[0] - $a[0]; });
          $g['asuntos'] = array_values(array_unique(array_column(array_slice($g['asuntos'], 0, 6), 1)));
          $g['asuntos'] = array_slice($g['asuntos'], 0, 3);
          $g['ultimo'] = $g['ultimo'] ? gmdate('c', $g['ultimo']) : null;
        }
        unset($g);
        $out = ['ok' => true, 'carpeta' => $carpeta, 'total' => count($uids), 'remitentes' => array_values($grupos)];
        if (!empty($b['aprender'])) {
          $sistema = array_values($imap->especiales());
          $aprendido = [];
          foreach ($imap->carpetas(false) as $c) {
            if ($c['ruta'] === 'INBOX' || $c['ruta'] === $carpeta || in_array($c['ruta'], $sistema, true) || !$c['se_puede_abrir']) continue;
            // copias viejas de Enviados/Papelera con otro nombre: no enseñan a dónde va cada remitente
            if (in_array(strtolower($c['nombre']), ['sent messages', 'deleted messages', 'deleted items', 'sent items', 'drafts', 'trash', 'spam', 'junk'], true)) continue;
            $imap->abrir($c['ruta'], true);
            $us = $imap->buscar([]);
            if (!$us) continue;
            foreach ($imap->encabezadosVarios($us, ['FROM']) as $x) {
              $e = _primerEmail(Mime::decodificarEncabezado($x['h']['from'] ?? ''));
              if ($e === '') continue;
              $aprendido[$e][$c['ruta']] = ($aprendido[$e][$c['ruta']] ?? 0) + 1;
            }
          }
          $out['aprendido'] = $aprendido;
        }
        return $out;
      }

      // ordenar {carpeta?, reglas:[{patron, carpeta}], simular?}
      //   patron = "persona@dominio.com" (ese remitente) o "@dominio.com" (todo el dominio, también subdominios).
      //   Mueve de la carpeta (por defecto la Bandeja) a la carpeta de cada regla. simular: solo cuenta.
      case 'ordenar': {
        $reglas = (array)($b['reglas'] ?? []);
        if (!$reglas) throw new Exception('Faltan las reglas');
        if (count($reglas) > 500) throw new Exception('Demasiadas reglas en una sola orden (máx. 500)');
        $simular = !empty($b['simular']);
        $carpetasExisten = array_column($imap->carpetas(false), 'ruta');
        $imap->abrir($carpeta, $simular);
        $res = []; $total = 0;
        foreach ($reglas as $r) {
          $patron = strtolower(trim((string)($r['patron'] ?? '')));
          $destino = (string)($r['carpeta'] ?? '');
          $fila = ['patron' => $patron, 'carpeta' => $destino, 'encontrados' => 0, 'movidos' => 0];
          if (!preg_match('/^([^@\s]+)?@[a-z0-9.-]+\.[a-z]{2,}$/', $patron)) { $fila['error'] = 'patrón inválido'; $res[] = $fila; continue; }
          if (!in_array($destino, $carpetasExisten, true)) { $fila['error'] = 'no existe la carpeta'; $res[] = $fila; continue; }
          if ($destino === $carpeta) { $fila['error'] = 'es la misma carpeta'; $res[] = $fila; continue; }
          // el servidor busca "contiene"; después se confirma remitente por remitente
          $cand = $imap->buscar(['de' => ltrim($patron, '@')]);
          $uids = [];
          foreach ($imap->encabezadosVarios($cand, ['FROM']) as $uid => $x)
            if (coincideRemitente(_primerEmail(Mime::decodificarEncabezado($x['h']['from'] ?? '')), $patron)) $uids[] = $uid;
          $fila['encontrados'] = count($uids);
          if ($uids && !$simular) { $imap->mover($uids, $destino); $fila['movidos'] = count($uids); $total += count($uids); }
          $res[] = $fila;
        }
        return ['ok' => true, 'simulado' => $simular, 'movidos' => $total, 'reglas' => $res];
      }

      // enviar {para, cc?, cco?, asunto, texto?, html?, adjuntos?:[{nombre,tipo,base64}],
      //         de_nombre?, responder?:{carpeta,uid,todos?}, reenviar?:{carpeta,uid}}
      // guardar_borrador: los mismos campos; lo deja en Borradores sin mandarlo.
      case 'enviar':
      case 'guardar_borrador': {
        $msg = armarMensaje($imap, $b, $usuario);
        if ($accion === 'guardar_borrador') {
          $dest = $imap->especial('\\Drafts') ?: 'INBOX.Drafts';
          $imap->agregar($dest, $msg['con_cco'], ['\\Draft', '\\Seen']);
          return ['ok' => true, 'guardado_en' => $dest, 'message_id' => $msg['message_id']];
        }
        if (!$msg['destinatarios']) throw new Exception('Falta a quién mandarlo');
        $smtp = new Smtp();
        $smtp->enviar(SMTP_HOST, SMTP_PORT, $usuario, $clave, $usuario, $msg['destinatarios'], $msg['sin_cco']);
        $res = ['ok' => true, 'enviado' => true, 'message_id' => $msg['message_id'], 'destinatarios' => count($msg['destinatarios'])];
        // copia en Enviados y marca de respondido: si fallan, el correo ya salió igual (se avisa)
        try {
          $env = $imap->especial('\\Sent') ?: 'INBOX.Sent';
          $imap->agregar($env, $msg['con_cco'], ['\\Seen']);
          $res['copia_en'] = $env;
        } catch (Throwable $e) { $res['aviso'] = 'Se envió, pero no se pudo guardar la copia en Enviados: ' . $e->getMessage(); }
        if (!empty($msg['respondido'])) {
          try { $imap->abrir($msg['respondido']['carpeta'], false); $imap->marcar([$msg['respondido']['uid']], ['\\Answered'], []); } catch (Throwable $e) { /* no es grave */ }
        }
        return $res;
      }
    }
    throw new Exception('Acción desconocida: ' . $accion);
  } finally {
    $imap->salir();
  }
}

function listaUids(array $b) {
  $u = $b['uids'] ?? (isset($b['uid']) ? [$b['uid']] : []);
  $u = array_values(array_unique(array_filter(array_map('intval', (array)$u))));
  if (!$u) throw new Exception('Faltan los uids');
  if (count($u) > 2000) throw new Exception('Demasiados correos en una sola orden (máx. 2000)');
  return $u;
}

/* ------------------------------------------------------------------ armado del correo */
function armarMensaje(Imap $imap, array $b, $usuario) {
  $para = Direcciones::lista($b['para'] ?? []);
  $cc = Direcciones::lista($b['cc'] ?? []);
  $cco = Direcciones::lista($b['cco'] ?? []);
  $asunto = (string)($b['asunto'] ?? '');
  $texto = (string)($b['texto'] ?? '');
  $html = (string)($b['html'] ?? '');
  $adjuntos = [];
  foreach ((array)($b['adjuntos'] ?? []) as $a) {
    $d = base64_decode((string)($a['base64'] ?? ''), true);
    if ($d === false) throw new Exception('Adjunto mal codificado: ' . ($a['nombre'] ?? ''));
    $adjuntos[] = ['nombre' => (string)($a['nombre'] ?? 'adjunto'), 'tipo' => (string)($a['tipo'] ?? 'application/octet-stream'), 'datos' => $d];
  }
  $extra = []; $respondido = null;

  if (!empty($b['responder']['uid'])) {
    $car = (string)($b['responder']['carpeta'] ?? 'INBOX'); $uid = (int)$b['responder']['uid'];
    $imap->abrir($car, true);
    $h = $imap->encabezados($uid, ['MESSAGE-ID', 'REFERENCES', 'SUBJECT', 'FROM', 'REPLY-TO', 'TO', 'CC']);
    if (!$h) throw new Exception('No existe el correo a responder');
    $mid = trim($h['message-id'] ?? '');
    if ($mid !== '') { $extra['In-Reply-To'] = $mid; $extra['References'] = trim(trim($h['references'] ?? '') . ' ' . $mid); }
    if ($asunto === '') { $s = Mime::decodificarEncabezado($h['subject'] ?? ''); $asunto = preg_match('/^\s*(re|rv|aw)\s*:/i', $s) ? $s : 'Re: ' . $s; }
    if (!$para) $para = Direcciones::lista(Mime::decodificarEncabezado(($h['reply-to'] ?? '') !== '' ? $h['reply-to'] : ($h['from'] ?? '')));
    if (!empty($b['responder']['todos'])) {
      $yo = strtolower($usuario);
      $ya = array_map('strtolower', array_column($para, 'email'));
      foreach (Direcciones::lista(Mime::decodificarEncabezado(($h['to'] ?? '') . ',' . ($h['cc'] ?? ''))) as $d)
        if (strtolower($d['email']) !== $yo && !in_array(strtolower($d['email']), $ya, true)) { $cc[] = $d; $ya[] = strtolower($d['email']); }
    }
    $respondido = ['carpeta' => $car, 'uid' => $uid];
  }
  if (!empty($b['reenviar']['uid'])) {
    $car = (string)($b['reenviar']['carpeta'] ?? 'INBOX'); $uid = (int)$b['reenviar']['uid'];
    $imap->abrir($car, true);
    $raw = $imap->crudo($uid);
    if ($raw === null) throw new Exception('No existe el correo a reenviar');
    $orig = Mime::parsear($raw);
    $s = $orig['enc']['subject'] ?? '';
    if ($asunto === '') $asunto = 'Rv: ' . $s;
    $adjuntos[] = ['nombre' => (preg_replace('/[\\\\\/:*?"<>|]+/', '_', $s) ?: 'correo') . '.eml', 'tipo' => 'message/rfc822', 'datos' => $raw];
  }

  $deNombre = (string)($b['de_nombre'] ?? 'Rosaint');
  $mid = '<' . bin2hex(random_bytes(12)) . '.' . time() . '@' . DOMINIO_MSGID . '>';
  $cab = [
    'Date' => date('r'),
    'From' => Direcciones::formatear([['nombre' => $deNombre, 'email' => $usuario]]),
    'To' => $para ? Direcciones::formatear($para) : null,
    'Cc' => $cc ? Direcciones::formatear($cc) : null,
    'Subject' => Mime::codificarEncabezado($asunto),
    'Message-ID' => $mid,
  ];
  foreach ($extra as $k => $v) $cab[$k] = $v;
  $cab['MIME-Version'] = '1.0';
  $cuerpo = Mime::armarCuerpo($texto, $html, $adjuntos);   // devuelve [encabezados de contenido, cuerpo]

  $lineas = function ($conCco) use ($cab, $cco, $cuerpo) {
    $out = '';
    foreach ($cab as $k => $v) {
      if ($v === null || $v === '') continue;
      $out .= $k . ': ' . $v . "\r\n";
    }
    // la copia que queda en Enviados lleva las copias ocultas; el correo que sale, no
    if ($conCco && $cco) $out .= 'Bcc: ' . Direcciones::formatear($cco) . "\r\n";
    // la línea en blanco separa encabezados y cuerpo: sin ella se perdía la primera parte (el texto)
    return $out . $cuerpo[0] . "\r\n\r\n" . $cuerpo[1];
  };
  $todos = array_merge($para, $cc, $cco);
  return ['sin_cco' => $lineas(false), 'con_cco' => $lineas(true), 'message_id' => $mid,
    'destinatarios' => array_values(array_unique(array_column($todos, 'email'))), 'respondido' => $respondido];
}

/* ================================================================== IMAP */
class Imap {
  protected $s; private $n = 0;
  public $capacidades = []; public $uidValidez = null; public $uidSiguiente = null;
  private $listaCache = null; private $abierta = null; private $abiertaSoloLectura = null;

  function conectar($host, $port) {
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host, 'SNI_enabled' => true]]);
    $this->s = @stream_socket_client('ssl://' . $host . ':' . $port, $errno, $errstr, 20, STREAM_CLIENT_CONNECT, $ctx);
    if (!$this->s) throw new Exception('No se pudo conectar al servidor de correo: ' . $errstr);
    stream_set_timeout($this->s, 90);
    $saludo = $this->linea();
    if (strpos($saludo, '* OK') !== 0) throw new Exception('El servidor de correo no saludó bien');
    if (preg_match('/\[CAPABILITY ([^\]]+)\]/i', $saludo, $m)) $this->capacidades = explode(' ', strtoupper($m[1]));
  }
  function login($u, $p) {
    $r = $this->cmd('LOGIN ' . self::lit($u) . ' ' . self::lit($p), false);
    if ($r['estado'] !== 'OK') throw new Exception('La casilla rechazó el usuario o la contraseña');
    foreach ($r['crudo'] as $x) if (preg_match('/^\* CAPABILITY (.+)/i', $x, $m)) $this->capacidades = explode(' ', strtoupper(trim($m[1])));
    if (preg_match('/\[CAPABILITY ([^\]]+)\]/i', $r['texto'], $m)) $this->capacidades = explode(' ', strtoupper($m[1]));
  }
  function salir() { if ($this->s) { try { @fwrite($this->s, 'z LOGOUT' . "\r\n"); } catch (Throwable $e) {} @fclose($this->s); $this->s = null; } }

  /* --- bajo nivel: lectura respetando los literales {n} --- */
  private function linea() {
    $l = fgets($this->s);
    if ($l === false) { $meta = stream_get_meta_data($this->s); throw new Exception($meta['timed_out'] ? 'El servidor de correo tardó demasiado' : 'El servidor de correo cerró la conexión'); }
    return $l;
  }
  private function leerBytes($n) {
    $out = '';
    while (strlen($out) < $n) {
      $c = fread($this->s, min(65536, $n - strlen($out)));
      if ($c === false || ($c === '' && feof($this->s))) throw new Exception('Se cortó la conexión leyendo el correo');
      $out .= $c;
    }
    return $out;
  }
  // una respuesta completa (con sus literales adentro)
  private function respuesta() {
    $r = '';
    while (true) {
      $l = $this->linea(); $r .= $l;
      if (preg_match('/\{(\d+)\}\r\n$/', $l, $m)) { $r .= $this->leerBytes((int)$m[1]); continue; }
      return $r;
    }
  }
  static function lit($s) { $s = (string)$s; return '{' . strlen($s) . "+}\r\n" . $s; }   // LITERAL+ (el servidor lo tiene)
  static function q($s) { return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $s) . '"'; }
  static function carpetaArg($ruta) { return self::lit(Utf7::codificar($ruta)); }

  // manda un comando y devuelve {estado, texto, crudo:[respuestas sin etiqueta], datos:[tokens]}
  function cmd($c, $tokens = true) {
    $tag = 'a' . (++$this->n);
    if (fwrite($this->s, $tag . ' ' . $c . "\r\n") === false) throw new Exception('No se pudo hablar con el servidor de correo');
    $crudo = []; $datos = [];
    while (true) {
      $r = $this->respuesta();
      if (strpos($r, $tag . ' ') === 0) {
        $p = explode(' ', rtrim($r, "\r\n"), 3);
        return ['estado' => strtoupper($p[1] ?? ''), 'texto' => $p[2] ?? '', 'crudo' => $crudo, 'datos' => $datos];
      }
      if ($r[0] === '+') continue;
      $crudo[] = $r;
      if ($tokens && $r[0] === '*') { $i = 0; $datos[] = Tok::parsear($r, $i); }
    }
  }
  function ok($c, $tokens = true) {
    $r = $this->cmd($c, $tokens);
    if ($r['estado'] !== 'OK') throw new Exception('El servidor de correo respondió: ' . trim($r['texto']) . ' [' . preg_replace('/\{\d+\+\}\r\n.*/s', '…', substr($c, 0, 60)) . ']');
    return $r;
  }

  /* --- carpetas --- */
  function carpetas($conteos) {
    $cmd = 'LIST "" "*"' . ($conteos && in_array('LIST-STATUS', $this->capacidades, true) ? ' RETURN (SPECIAL-USE STATUS (MESSAGES UNSEEN))' : '');
    $r = $this->ok($cmd);
    $lista = []; $status = [];
    foreach ($r['datos'] as $t) {
      $tipo = strtoupper((string)($t[1] ?? ''));
      if ($tipo === 'LIST') {
        $flags = array_map('strval', (array)$t[2]);
        $sep = $t[3] === null ? '' : (string)$t[3];
        $ruta = Utf7::decodificar((string)$t[4]);
        $esp = null;
        foreach ($flags as $f) if (in_array(strtolower($f), ['\\sent', '\\trash', '\\drafts', '\\junk', '\\archive', '\\all', '\\flagged'], true)) $esp = $f;
        if (strtoupper($ruta) === 'INBOX') $esp = '\\Inbox';
        $pos = $sep !== '' ? strrpos($ruta, $sep) : false;
        $lista[$ruta] = ['ruta' => $ruta, 'nombre' => $pos === false ? $ruta : substr($ruta, $pos + strlen($sep)), 'padre' => $pos === false ? null : substr($ruta, 0, $pos),
          'especial' => $esp, 'se_puede_abrir' => !in_array('\\noselect', array_map('strtolower', $flags), true), '_sep' => $sep];
      } elseif ($tipo === 'STATUS') {
        $ruta = Utf7::decodificar((string)$t[2]); $kv = (array)$t[3]; $st = [];
        for ($i = 0; $i + 1 < count($kv); $i += 2) $st[strtoupper($kv[$i])] = (int)$kv[$i + 1];
        $status[$ruta] = $st;
      }
    }
    foreach ($status as $ruta => $st) if (isset($lista[$ruta])) { $lista[$ruta]['total'] = $st['MESSAGES'] ?? null; $lista[$ruta]['sin_leer'] = $st['UNSEEN'] ?? null; }
    $this->listaCache = $lista; $this->especialesCache = null;
    return array_values(array_map(function ($c) { unset($c['_sep']); return $c; }, $lista));
  }
  private function lista() { if ($this->listaCache === null) $this->carpetas(false); return $this->listaCache; }
  function separador() { foreach ($this->lista() as $c) if ($c['_sep'] !== '') return $c['_sep']; return '.'; }
  private $especialesCache = null;
  function especiales() {
    if ($this->especialesCache !== null) return $this->especialesCache;
    $cand = [];
    foreach ($this->lista() as $c) if ($c['especial'] && $c['especial'] !== '\\Inbox') $cand[$c['especial']][] = $c['ruta'];
    // contacto@ tiene DOS carpetas marcadas \Sent ("Sent Items" con ~3.000 correos y "Sent Messages" con 69):
    // si hay más de una, manda la que más correos tiene (es la que usa el Outlook)
    $out = [];
    foreach ($cand as $esp => $rutas) {
      if (count($rutas) === 1) { $out[$esp] = $rutas[0]; continue; }
      $mejor = null; $max = -1;
      foreach ($rutas as $r) { $t = $this->total($r); if ($t > $max) { $max = $t; $mejor = $r; } }
      $out[$esp] = $mejor;
    }
    // si el servidor no las marca, por nombre
    $nombres = ['\\Sent' => ['sent', 'enviados', 'sent items', 'sent messages'], '\\Trash' => ['trash', 'papelera', 'deleted items', 'deleted messages'],
      '\\Drafts' => ['drafts', 'borradores'], '\\Junk' => ['junk', 'spam', 'correo no deseado']];
    foreach ($nombres as $esp => $ns) if (!isset($out[$esp])) foreach ($this->lista() as $c) if (in_array(strtolower($c['nombre']), $ns, true)) { $out[$esp] = $c['ruta']; break; }
    return $this->especialesCache = $out;
  }
  function especial($esp) { $e = $this->especiales(); return $e[$esp] ?? null; }
  function existeCarpeta($ruta) { if (!isset($this->lista()[$ruta])) throw new Exception('No existe la carpeta "' . $ruta . '"'); }
  function total($ruta) {
    $r = $this->ok('STATUS ' . self::carpetaArg($ruta) . ' (MESSAGES)');
    foreach ($r['datos'] as $t) if (strtoupper((string)($t[1] ?? '')) === 'STATUS') { $kv = (array)$t[3]; return (int)($kv[1] ?? 0); }
    return 0;
  }
  function crearCarpeta($ruta) {
    if (isset($this->lista()[$ruta])) throw new Exception('Ya existe la carpeta "' . $ruta . '"');
    $this->ok('CREATE ' . self::carpetaArg($ruta));
    $this->cmd('SUBSCRIBE ' . self::carpetaArg($ruta));
    $this->listaCache = null;
  }
  function renombrarCarpeta($de, $a) {
    if (isset($this->lista()[$a])) throw new Exception('Ya existe una carpeta "' . $a . '"');
    $this->ok('RENAME ' . self::carpetaArg($de) . ' ' . self::carpetaArg($a));
    $this->cmd('UNSUBSCRIBE ' . self::carpetaArg($de)); $this->cmd('SUBSCRIBE ' . self::carpetaArg($a));
    $this->listaCache = null;
  }
  function borrarCarpeta($ruta) {
    if ($this->abierta === $ruta) { $this->cmd('UNSELECT'); $this->abierta = null; }
    $this->ok('DELETE ' . self::carpetaArg($ruta));
    $this->cmd('UNSUBSCRIBE ' . self::carpetaArg($ruta));
    $this->listaCache = null;
  }

  /* --- mensajes --- */
  function abrir($ruta, $soloLectura) {
    // abierta con escritura sirve para todo; abierta en solo lectura y hace falta escribir → se reabre
    if ($this->abierta === $ruta && ($this->abiertaSoloLectura === false || $soloLectura)) return;
    $r = $this->ok(($soloLectura ? 'EXAMINE ' : 'SELECT ') . self::carpetaArg($ruta), false);
    foreach ($r['crudo'] as $x) {
      if (preg_match('/\[UIDVALIDITY (\d+)\]/i', $x, $m)) $this->uidValidez = (int)$m[1];
      if (preg_match('/\[UIDNEXT (\d+)\]/i', $x, $m)) $this->uidSiguiente = (int)$m[1];
    }
    $this->abierta = $ruta; $this->abiertaSoloLectura = $soloLectura;
  }
  function buscar(array $b) {
    $c = [];
    $fecha = function ($s) { $t = strtotime((string)$s); if ($t === false) throw new Exception('Fecha inválida: ' . $s); return date('j-M-Y', $t); };
    if (!empty($b['desde'])) $c[] = 'SINCE ' . $fecha($b['desde']);
    if (!empty($b['hasta'])) $c[] = 'BEFORE ' . $fecha($b['hasta']);
    foreach (['de' => 'FROM', 'para' => 'TO', 'asunto' => 'SUBJECT', 'texto' => 'TEXT', 'cuerpo' => 'BODY'] as $k => $cl)
      if (isset($b[$k]) && trim((string)$b[$k]) !== '') $c[] = $cl . ' ' . self::lit(trim((string)$b[$k]));
    // "q": búsqueda rápida en remitente, destinatario o asunto (solo encabezados: ~1 s).
    // "texto" busca también dentro del cuerpo y en contacto@ tarda ~90 s (recorre los 9.700 correos).
    if (isset($b['q']) && trim((string)$b['q']) !== '') { $l = trim((string)$b['q']); $c[] = 'OR OR FROM ' . self::lit($l) . ' SUBJECT ' . self::lit($l) . ' TO ' . self::lit($l); }
    if (!empty($b['sin_leer'])) $c[] = 'UNSEEN';
    if (!empty($b['destacados'])) $c[] = 'FLAGGED';
    if (!empty($b['desde_uid'])) $c[] = 'UID ' . (int)$b['desde_uid'] . ':*';
    if (!$c) $c[] = 'ALL';
    $r = $this->ok('UID SEARCH CHARSET UTF-8 ' . implode(' ', $c));
    $uids = [];
    foreach ($r['datos'] as $t) if (strtoupper((string)($t[1] ?? '')) === 'SEARCH') for ($i = 2; $i < count($t); $i++) $uids[] = (int)$t[$i];
    // "UID n:*" siempre devuelve el último aunque sea menor: se filtra
    if (!empty($b['desde_uid'])) $uids = array_values(array_filter($uids, function ($u) use ($b) { return $u >= (int)$b['desde_uid']; }));
    return $uids;
  }
  private static function rango(array $uids) { sort($uids, SORT_NUMERIC); return implode(',', $uids); }
  private function fetch(array $uids, $que) {
    $out = [];
    foreach (array_chunk($uids, 200) as $parte) {
      $r = $this->ok('UID FETCH ' . self::rango($parte) . ' ' . $que);
      foreach ($r['datos'] as $t) {
        if (strtoupper((string)($t[2] ?? '')) !== 'FETCH') continue;
        $kv = (array)$t[3]; $m = [];
        for ($i = 0; $i + 1 < count($kv); $i += 2) $m[strtoupper(preg_replace('/^BODY\[(.*)\]$/i', 'BODY[$1]', (string)$kv[$i]))] = $kv[$i + 1];
        if (isset($m['UID'])) $out[(int)$m['UID']] = $m;
      }
    }
    return $out;
  }
  function resumenes(array $uids) {
    if (!$uids) return [];
    $campos = 'FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO CONTENT-TYPE REPLY-TO';
    $f = $this->fetch($uids, '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (' . $campos . ')])');
    $out = [];
    foreach ($uids as $u) {
      if (!isset($f[$u])) continue;
      $m = $f[$u]; $hraw = '';
      foreach ($m as $k => $v) if (strpos($k, 'BODY[HEADER.FIELDS') === 0) $hraw = (string)$v;
      $h = Mime::encabezados($hraw);
      $flags = array_map('strval', (array)($m['FLAGS'] ?? []));
      $fl = array_map('strtolower', $flags);
      $ct = strtolower($h['content-type'] ?? '');
      $de = Mime::decodificarEncabezado($h['from'] ?? '');
      $deL = Direcciones::listaSegura($de);
      $fechaH = isset($h['date']) ? fechaCorreo($h['date']) : false;
      $out[] = [
        'uid' => $u,
        'fecha' => $fechaH ? gmdate('c', $fechaH) : (isset($m['INTERNALDATE']) ? gmdate('c', strtotime((string)$m['INTERNALDATE'])) : null),
        'recibido' => isset($m['INTERNALDATE']) ? gmdate('c', strtotime((string)$m['INTERNALDATE'])) : null,
        'de' => $de, 'de_email' => $deL ? strtolower($deL[0]['email']) : '', 'de_nombre' => $deL ? $deL[0]['nombre'] : '',
        'para' => Mime::decodificarEncabezado($h['to'] ?? ''), 'cc' => Mime::decodificarEncabezado($h['cc'] ?? ''),
        'asunto' => Mime::decodificarEncabezado($h['subject'] ?? ''),
        'message_id' => trim($h['message-id'] ?? ''), 'en_respuesta_a' => trim($h['in-reply-to'] ?? ''),
        'tamano' => (int)($m['RFC822.SIZE'] ?? 0),
        'leido' => in_array('\\seen', $fl, true), 'destacado' => in_array('\\flagged', $fl, true), 'respondido' => in_array('\\answered', $fl, true),
        'marcas' => $flags,
        'tiene_adjuntos' => strpos($ct, 'multipart/mixed') === 0 || strpos($ct, 'application/') === 0,
      ];
    }
    return $out;
  }
  // encabezados + marcas de muchos correos (de a 500 por pedido) → [uid => ['h' => [...], 'flags' => [...]]]
  function encabezadosVarios(array $uids, array $campos) {
    $out = [];
    foreach (array_chunk($uids, 500) as $parte) {
      foreach ($this->fetch($parte, '(UID FLAGS BODY.PEEK[HEADER.FIELDS (' . implode(' ', $campos) . ')])') as $uid => $m) {
        $hraw = '';
        foreach ($m as $k => $v) if (strpos($k, 'BODY[HEADER.FIELDS') === 0) $hraw = (string)$v;
        $out[$uid] = ['h' => Mime::encabezados($hraw), 'flags' => array_map('strval', (array)($m['FLAGS'] ?? []))];
      }
    }
    return $out;
  }
  function encabezados($uid, array $campos) {
    $f = $this->fetch([$uid], '(UID BODY.PEEK[HEADER.FIELDS (' . implode(' ', $campos) . ')])');
    if (!isset($f[$uid])) return null;
    foreach ($f[$uid] as $k => $v) if (strpos($k, 'BODY[HEADER.FIELDS') === 0) return Mime::encabezados((string)$v);
    return [];
  }
  function crudo($uid) {
    $f = $this->fetch([$uid], '(UID BODY.PEEK[])');
    return isset($f[$uid]['BODY[]']) ? (string)$f[$uid]['BODY[]'] : null;
  }
  function marcar(array $uids, array $mas, array $menos) {
    foreach (array_chunk($uids, 500) as $p) {
      if ($mas) $this->ok('UID STORE ' . self::rango($p) . ' +FLAGS.SILENT (' . implode(' ', $mas) . ')');
      if ($menos) $this->ok('UID STORE ' . self::rango($p) . ' -FLAGS.SILENT (' . implode(' ', $menos) . ')');
    }
  }
  private static function copyuid($texto) { return preg_match('/\[COPYUID \d+ ([\d:,]+) ([\d:,]+)\]/i', $texto, $m) ? $m[2] : null; }
  function mover(array $uids, $destino) {
    $nuevos = [];
    foreach (array_chunk($uids, 500) as $p) {
      if (in_array('MOVE', $this->capacidades, true)) {
        $r = $this->ok('UID MOVE ' . self::rango($p) . ' ' . self::carpetaArg($destino));
        foreach (array_merge([$r['texto']], $r['crudo']) as $x) if ($c = self::copyuid($x)) $nuevos[] = $c;
      } else {
        $r = $this->ok('UID COPY ' . self::rango($p) . ' ' . self::carpetaArg($destino));
        if ($c = self::copyuid($r['texto'])) $nuevos[] = $c;
        $this->borrarDefinitivo($p);
      }
    }
    return implode(',', $nuevos) ?: null;
  }
  function copiar(array $uids, $destino) {
    $nuevos = [];
    foreach (array_chunk($uids, 500) as $p) { $r = $this->ok('UID COPY ' . self::rango($p) . ' ' . self::carpetaArg($destino)); if ($c = self::copyuid($r['texto'])) $nuevos[] = $c; }
    return implode(',', $nuevos) ?: null;
  }
  function borrarDefinitivo(array $uids) {
    foreach (array_chunk($uids, 500) as $p) {
      $this->ok('UID STORE ' . self::rango($p) . ' +FLAGS.SILENT (\\Deleted)');
      // UID EXPUNGE borra SOLO estos (no otros que ya estuvieran marcados para borrar)
      if (in_array('UIDPLUS', $this->capacidades, true)) $this->ok('UID EXPUNGE ' . self::rango($p));
      else throw new Exception('El servidor no permite borrar solo algunos correos (falta UIDPLUS)');
    }
  }
  function agregar($carpeta, $mensaje, array $flags) {
    $this->ok('APPEND ' . self::carpetaArg($carpeta) . ' (' . implode(' ', $flags) . ') ' . self::lit($mensaje), false);
  }
}

/* ------------------------------------------------------------------ lector de respuestas IMAP */
class Tok {
  // convierte una respuesta en listas anidadas: átomos/strings como string, NIL como null, (..) como array
  static function parsear($s, &$i, $hastaParen = false) {
    $out = []; $n = strlen($s);
    while ($i < $n) {
      $c = $s[$i];
      if ($c === ' ' || $c === "\r" || $c === "\n") { $i++; continue; }
      if ($c === '(') { $i++; $out[] = self::parsear($s, $i, true); continue; }
      if ($c === ')') { $i++; if ($hastaParen) return $out; continue; }
      if ($c === '"') {
        $i++; $v = '';
        while ($i < $n && $s[$i] !== '"') { if ($s[$i] === '\\' && $i + 1 < $n) $i++; $v .= $s[$i]; $i++; }
        $i++; $out[] = $v; continue;
      }
      if ($c === '{' && preg_match('/\{(\d+)\+?\}\r\n/A', $s, $m, 0, $i)) {
        $i += strlen($m[0]); $len = (int)$m[1];
        $out[] = substr($s, $i, $len); $i += $len; continue;
      }
      // átomo; lo que va entre [ ] es parte del átomo (BODY[HEADER.FIELDS (FROM TO)])
      $v = ''; $prof = 0;
      while ($i < $n) {
        $c = $s[$i];
        if ($prof === 0 && ($c === ' ' || $c === '(' || $c === ')' || $c === "\r" || $c === "\n")) break;
        if ($c === '[') $prof++; elseif ($c === ']') $prof = max(0, $prof - 1);
        $v .= $c; $i++;
      }
      $out[] = strtoupper($v) === 'NIL' ? null : $v;
    }
    return $out;
  }
}

/* ------------------------------------------------------------------ nombres de carpeta (UTF-7 modificado, RFC 3501) */
class Utf7 {
  static function decodificar($s) {
    return preg_replace_callback('/&([^-]*)-/', function ($m) {
      if ($m[1] === '') return '&';
      $b = base64_decode(strtr($m[1], ',', '/'));
      return mb_convert_encoding($b, 'UTF-8', 'UTF-16BE');
    }, $s);
  }
  static function codificar($s) {
    $out = ''; $buf = '';
    $vaciar = function () use (&$buf, &$out) {
      if ($buf === '') return;
      $out .= '&' . rtrim(strtr(base64_encode(mb_convert_encoding($buf, 'UTF-16BE', 'UTF-8')), '/', ','), '=') . '-';
      $buf = '';
    };
    foreach (preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
      $o = ord($ch[0]);
      if (strlen($ch) === 1 && $o >= 0x20 && $o <= 0x7e) { $vaciar(); $out .= $ch === '&' ? '&-' : $ch; }
      else $buf .= $ch;
    }
    $vaciar();
    return $out;
  }
}

/* ------------------------------------------------------------------ direcciones */
class Direcciones {
  // acepta "a@b.com", "Nombre <a@b.com>, otro@c.com", o [ "a@b", {nombre,email} ]
  static function lista($v) {
    $items = [];
    if (is_array($v)) {
      foreach ($v as $x) {
        if (is_array($x)) { if (!empty($x['email'])) $items[] = ['nombre' => (string)($x['nombre'] ?? ''), 'email' => trim((string)$x['email'])]; }
        else foreach (self::lista((string)$x) as $y) $items[] = $y;
      }
    } else {
      $s = (string)$v; $partes = []; $act = ''; $q = false; $ang = false;
      for ($i = 0; $i < strlen($s); $i++) {
        $c = $s[$i];
        if ($c === '"') $q = !$q; elseif ($c === '<') $ang = true; elseif ($c === '>') $ang = false;
        if (($c === ',' || $c === ';') && !$q && !$ang) { $partes[] = $act; $act = ''; continue; }
        $act .= $c;
      }
      $partes[] = $act;
      foreach ($partes as $p) {
        $p = trim($p); if ($p === '') continue;
        if (preg_match('/^(.*)<([^>]+)>\s*$/s', $p, $m)) $items[] = ['nombre' => trim(trim($m[1]), '"\' '), 'email' => trim($m[2])];
        else $items[] = ['nombre' => '', 'email' => trim($p, '<> ')];
      }
    }
    foreach ($items as $it) if (!filter_var($it['email'], FILTER_VALIDATE_EMAIL)) throw new Exception('Dirección inválida: ' . $it['email']);
    return $items;
  }
  static function listaSegura($v) { try { return self::lista($v); } catch (Throwable $e) { return []; } }
  static function formatear(array $l) {
    return implode(', ', array_map(function ($d) {
      if ($d['nombre'] === '') return $d['email'];
      $n = preg_match('/[^\x20-\x7e]/', $d['nombre']) ? Mime::codificarEncabezado($d['nombre']) : '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $d['nombre']) . '"';
      return $n . ' <' . $d['email'] . '>';
    }, $l));
  }
}

/* ================================================================== MIME */
class Mime {
  static function encabezados($raw) {
    $raw = preg_replace("/\r?\n[ \t]+/", ' ', str_replace("\r\n", "\n", $raw));
    $h = [];
    foreach (explode("\n", $raw) as $l) {
      $p = strpos($l, ':'); if ($p === false || $p === 0) continue;
      $k = strtolower(trim(substr($l, 0, $p))); $v = trim(substr($l, $p + 1));
      if (!isset($h[$k])) $h[$k] = $v;   // el primero manda
    }
    return $h;
  }
  static function aUtf8($s, $charset) {
    $cs = strtolower(trim((string)$charset, " \"'"));
    if ($cs === '' || $cs === 'us-ascii' || $cs === 'ascii') $cs = 'utf-8';
    if ($cs === 'utf-8' || $cs === 'utf8') { if (mb_check_encoding($s, 'UTF-8')) return $s; $cs = 'windows-1252'; }
    $map = ['iso-8859-1' => 'Windows-1252', 'latin1' => 'Windows-1252', 'cp1252' => 'Windows-1252', 'windows-1252' => 'Windows-1252', 'iso-8859-15' => 'ISO-8859-15', 'gb2312' => 'GB18030', 'gbk' => 'GB18030'];
    $cs = $map[$cs] ?? $cs;
    try { $r = @mb_convert_encoding($s, 'UTF-8', $cs); if ($r !== false) return $r; } catch (Throwable $e) { }
    return mb_convert_encoding($s, 'UTF-8', 'Windows-1252');
  }
  static function decodificarEncabezado($s) {
    $s = (string)$s;
    $s = preg_replace('/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/', '$1', $s);   // espacios entre palabras codificadas no cuentan
    $s = preg_replace_callback('/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/', function ($m) {
      $d = strtoupper($m[2]) === 'B' ? base64_decode($m[3]) : quoted_printable_decode(str_replace('_', ' ', $m[3]));
      return self::aUtf8($d, $m[1]);
    }, $s);
    return mb_check_encoding($s, 'UTF-8') ? $s : self::aUtf8($s, 'windows-1252');
  }
  static function codificarEncabezado($s) {
    if (!preg_match('/[^\x20-\x7e]/', $s)) return $s;
    return mb_encode_mimeheader($s, 'UTF-8', 'B', "\r\n", 9);
  }
  // valor + parámetros de Content-Type / Content-Disposition (incluye filename*=utf-8''... y partidos *0*)
  static function valorYParams($v) {
    $partes = []; $act = ''; $q = false;
    for ($i = 0; $i < strlen($v); $i++) { $c = $v[$i]; if ($c === '"') $q = !$q; if ($c === ';' && !$q) { $partes[] = $act; $act = ''; continue; } $act .= $c; }
    $partes[] = $act;
    $valor = strtolower(trim(array_shift($partes)));
    $p = []; $trozos = [];
    foreach ($partes as $x) {
      $e = strpos($x, '='); if ($e === false) continue;
      $k = strtolower(trim(substr($x, 0, $e))); $val = trim(substr($x, $e + 1));
      if (strlen($val) > 1 && $val[0] === '"') $val = stripcslashes(substr($val, 1, -1));
      // RFC 2231: "filename*" (codificado) · "filename*0" (trozo sin codificar) · "filename*0*" (trozo codificado)
      if (preg_match('/^([a-z0-9_-]+)\*(?:(\d+)(\*)?)?$/', $k, $m)) {
        $num = isset($m[2]) && $m[2] !== '' ? (int)$m[2] : 0;
        $codif = !isset($m[2]) || $m[2] === '' || !empty($m[3]);
        $trozos[$m[1]][$num] = [$val, $codif]; continue;
      }
      $p[$k] = $val;
    }
    foreach ($trozos as $k => $ts) {
      ksort($ts); $cs = 'utf-8'; $txt = '';
      foreach ($ts as $n => $t) {
        list($val, $codif) = $t;
        if ($n === 0 && preg_match("/^([^']*)'[^']*'(.*)$/s", $val, $m)) { $cs = $m[1] ?: 'utf-8'; $val = $m[2]; $codif = true; }
        $txt .= $codif ? rawurldecode($val) : $val;
      }
      $p[$k] = self::aUtf8($txt, $cs);
    }
    foreach ($p as $k => $v2) $p[$k] = self::decodificarEncabezado($v2);
    return [$valor, $p];
  }
  static function decodificarCuerpo($s, $enc) {
    $e = strtolower(trim((string)$enc));
    if ($e === 'base64') return (string)base64_decode(preg_replace('/[^A-Za-z0-9+\/=]/', '', $s));
    if ($e === 'quoted-printable') return quoted_printable_decode($s);
    return $s;
  }
  // árbol del correo: cada parte con su número IMAP ("1", "1.2", ...)
  static function parsear($raw, $numero = '') {
    if (preg_match('/^\r?\n/', $raw)) $raw = "Content-Type: text/plain\r\n" . $raw;   // parte sin encabezados
    $sep = strpos($raw, "\r\n\r\n"); $lsep = 4;
    $sep2 = strpos($raw, "\n\n");
    if ($sep === false || ($sep2 !== false && $sep2 < $sep)) { $sep = $sep2; $lsep = 2; }
    if ($sep === false) { $hraw = $raw; $cuerpo = ''; } else { $hraw = substr($raw, 0, $sep); $cuerpo = substr($raw, $sep + $lsep); }
    $h = self::encabezados($hraw);
    list($tipo, $pt) = self::valorYParams($h['content-type'] ?? 'text/plain; charset=us-ascii');
    if ($tipo === '') $tipo = 'text/plain';
    list($disp, $pd) = self::valorYParams($h['content-disposition'] ?? '');
    $nodo = ['numero' => $numero === '' ? '1' : $numero, 'tipo' => $tipo, 'charset' => $pt['charset'] ?? '', 'disposicion' => $disp,
      'nombre' => $pd['filename'] ?? ($pt['name'] ?? ''), 'cid' => trim($h['content-id'] ?? '', '<> '), 'enc' => [], 'hijos' => [], 'es_mensaje' => false];
    foreach (['subject', 'from', 'to', 'cc', 'date', 'message-id', 'reply-to'] as $k) if (isset($h[$k])) $nodo['enc'][$k] = self::decodificarEncabezado($h[$k]);
    if (strpos($tipo, 'multipart/') === 0 && !empty($pt['boundary'])) {
      $b = '--' . $pt['boundary'];
      $trozos = preg_split('/(?:^|\r?\n)' . preg_quote($b, '/') . '(--|)[ \t]*(?=\r?\n|$)/', $cuerpo, -1, PREG_SPLIT_DELIM_CAPTURE);
      array_shift($trozos);   // preámbulo
      $k = 0;
      // quedan pares [marca de cierre "--" o "", contenido]; lo que sigue al cierre es epílogo
      for ($j = 0; $j + 1 < count($trozos); $j += 2) {
        if ($trozos[$j] === '--') break;
        $t = preg_replace('/^\r?\n/', '', $trozos[$j + 1]);
        if (trim($t) === '') continue;
        $k++;
        $nodo['hijos'][] = self::parsear($t, ($numero === '' ? '' : $numero . '.') . $k);
      }
      return $nodo;
    }
    $datos = self::decodificarCuerpo($cuerpo, $h['content-transfer-encoding'] ?? '');
    $nodo['datos'] = $datos;
    if ($tipo === 'message/rfc822') { $nodo['es_mensaje'] = true; $nodo['cuerpo_crudo'] = $datos; if ($nodo['nombre'] === '') { $sub = self::encabezados(substr($datos, 0, 8000)); $nodo['nombre'] = (self::decodificarEncabezado($sub['subject'] ?? 'correo adjunto')) . '.eml'; } }
    return $nodo;
  }
  static function hojas(array $n, array &$out) { if ($n['hijos']) { foreach ($n['hijos'] as $h) self::hojas($h, $out); } else $out[] = $n; }
  static function buscarParte(array $n, $parte) { $hs = []; self::hojas($n, $hs); foreach ($hs as $h) if ($h['numero'] === $parte) return $h; return null; }
  static function resumen(array $m) {
    $hs = []; self::hojas($m, $hs);
    $texto = null; $html = null; $adj = [];
    foreach ($hs as $h) {
      $esAdj = $h['disposicion'] === 'attachment' || $h['es_mensaje'] || ($h['nombre'] !== '' && strpos($h['tipo'], 'text/') !== 0);
      if (!$esAdj && $h['tipo'] === 'text/plain' && $texto === null) { $texto = self::aUtf8($h['datos'], $h['charset']); continue; }
      if (!$esAdj && $h['tipo'] === 'text/html' && $html === null) { $html = self::aUtf8($h['datos'], $h['charset']); continue; }
      if ($esAdj || strpos($h['tipo'], 'text/') !== 0)
        $adj[] = ['parte' => $h['numero'], 'nombre' => $h['nombre'] ?: ('adjunto-' . $h['numero']), 'tipo' => $h['tipo'], 'tamano' => strlen($h['es_mensaje'] ? $h['cuerpo_crudo'] : $h['datos']),
          'en_linea' => $h['disposicion'] === 'inline' || ($h['cid'] !== '' && $h['disposicion'] !== 'attachment'), 'cid' => $h['cid'] ?: null];
    }
    $enlaces = [];
    if ($html !== null) {
      preg_match_all('/<a\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)<\/a>/is', $html, $mm, PREG_SET_ORDER);
      foreach ($mm as $x) { $u = html_entity_decode($x[1]); if (!preg_match('/^https?:/i', $u)) continue; $enlaces[] = ['texto' => mb_substr(trim(preg_replace('/\s+/', ' ', strip_tags($x[2]))), 0, 120), 'url' => $u]; if (count($enlaces) >= 100) break; }
    }
    $plano = $texto;
    if ($html !== null) {
      $t = preg_replace('/<(style|script|head)\b.*?<\/\1>/is', ' ', $html);
      $t = preg_replace('/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/i', "\n", $t);
      $deHtml = html_entity_decode(strip_tags($t), ENT_QUOTES | ENT_HTML5, 'UTF-8');
      // sin texto plano, o el texto plano es un relleno ("habilite HTML para ver este correo"): manda el HTML
      $largoP = strlen(preg_replace('/\s+/', '', (string)$plano)); $largoH = strlen(preg_replace('/\s+/', '', $deHtml));
      if ($plano === null || $largoP === 0 || ($largoP < 60 && $largoH > 5 * $largoP)) $plano = $deHtml;
    }
    $plano = str_replace(["\r\n", "\r"], "\n", (string)$plano);   // saltos de línea parejos
    $plano = trim(preg_replace("/\n[ \t]*\n\s*/", "\n\n", preg_replace('/[ \t]+/', ' ', $plano)));
    $e = $m['enc'];
    $de = _primerEmail($e['from'] ?? '');
    return ['fecha' => isset($e['date']) && ($t = fechaCorreo($e['date'])) ? gmdate('c', $t) : null,
      'de' => $e['from'] ?? '', 'de_email' => $de, 'para' => $e['to'] ?? '', 'cc' => $e['cc'] ?? '', 'responder_a' => $e['reply-to'] ?? '',
      'asunto' => $e['subject'] ?? '', 'message_id' => $e['message-id'] ?? '',
      'texto' => mb_substr($plano, 0, 100000), 'html' => $html !== null ? mb_substr($html, 0, 400000) : null, 'enlaces' => $enlaces, 'adjuntos' => $adj];
  }
  // arma Content-Type y cuerpo del correo a enviar
  static function armarCuerpo($texto, $html, array $adjuntos) {
    if ($texto === '' && $html !== '') $texto = trim(html_entity_decode(strip_tags(preg_replace('/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/i', "\n", $html)), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $parteTexto = function ($s, $sub) {
      $s = str_replace(["\r\n", "\r"], "\n", $s); $s = str_replace("\n", "\r\n", $s);
      return ["Content-Type: text/$sub; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable", quoted_printable_encode($s)];
    };
    $bnd = function () { return '=_rst_' . bin2hex(random_bytes(10)); };
    $junto = function ($tipo, array $partes) use ($bnd) {
      $b = $bnd(); $c = '';
      foreach ($partes as $p) $c .= '--' . $b . "\r\n" . $p[0] . "\r\n\r\n" . $p[1] . "\r\n";
      return ["Content-Type: $tipo; boundary=\"$b\"", $c . '--' . $b . "--\r\n"];
    };
    $cuerpo = $html !== '' ? $junto('multipart/alternative', [$parteTexto($texto, 'plain'), $parteTexto($html, 'html')]) : $parteTexto($texto, 'plain');
    if (!$adjuntos) return $cuerpo;
    $partes = [$cuerpo];
    foreach ($adjuntos as $a) {
      $nom = $a['nombre']; $tipo = preg_replace('/[^a-z0-9.+\/-]/i', '', $a['tipo']) ?: 'application/octet-stream';
      $nomEnc = preg_match('/[^\x20-\x7e]/', $nom) ? self::codificarEncabezado($nom) : str_replace('"', '', $nom);
      $nom2231 = "UTF-8''" . rawurlencode($nom);
      if ($tipo === 'message/rfc822') {
        $partes[] = ["Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename=\"$nomEnc\"; filename*=$nom2231", $a['datos']];
      } else {
        $partes[] = ["Content-Type: $tipo; name=\"$nomEnc\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"$nomEnc\"; filename*=$nom2231", rtrim(chunk_split(base64_encode($a['datos']), 76, "\r\n"))];
      }
    }
    return $junto('multipart/mixed', $partes);
  }
}
// fecha del encabezado Date. Se saca el día de la semana: hay correos que lo traen mal y PHP
// entonces corre la fecha a ese día ("Tue, 11 Nov 2026" daba el martes 17).
function fechaCorreo($s) {
  $s = preg_replace('/^\s*[A-Za-z]{3,9},\s*/', '', (string)$s);
  $s = preg_replace('/\s*\([^)]*\)\s*$/', '', $s);
  return strtotime($s);
}
// ¿el remitente entra en la regla? "@dominio.com" = ese dominio y sus subdominios; si no, la dirección exacta
function coincideRemitente($email, $patron) {
  $email = strtolower(trim((string)$email)); $patron = strtolower(trim((string)$patron));
  if ($email === '' || $patron === '') return false;
  if ($patron[0] === '@') { $dom = substr($patron, 1); $de = substr($email, strrpos($email, '@') + 1); return $de === $dom || substr($de, -strlen($dom) - 1) === '.' . $dom; }
  return $email === $patron;
}
// dirección del remitente en minúsculas (para clasificar)
function _primerEmail($s) { try { $l = Direcciones::lista($s); return $l ? strtolower($l[0]['email']) : ''; } catch (Throwable $e) { return preg_match('/[\w.+-]+@[\w.-]+/', (string)$s, $m) ? strtolower($m[0]) : ''; } }

/* ================================================================== SMTP (Ferozo, puerto 465 con TLS) */
class Smtp {
  protected $s;
  protected function conectar($host, $port) {
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host, 'SNI_enabled' => true]]);
    $this->s = @stream_socket_client('ssl://' . $host . ':' . $port, $errno, $errstr, 20, STREAM_CLIENT_CONNECT, $ctx);
    if (!$this->s) throw new Exception('No se pudo conectar al servidor de envío: ' . $errstr);
  }
  private function resp() {
    $todo = '';
    while (true) {
      $l = fgets($this->s, 4096);
      if ($l === false) throw new Exception('El servidor de envío cerró la conexión');
      $todo .= $l;
      if (strlen($l) < 4 || $l[3] !== '-') return [(int)substr($l, 0, 3), $todo];
    }
  }
  private function cmd($c, $esperado, $mostrar = null) {
    fwrite($this->s, $c . "\r\n");
    list($cod, $txt) = $this->resp();
    if (!in_array($cod, (array)$esperado, true)) throw new Exception('El servidor de envío rechazó ' . ($mostrar ?? strtok($c, ' ')) . ': ' . trim($txt));
    return $txt;
  }
  function enviar($host, $port, $usuario, $clave, $remitente, array $destinatarios, $mensaje) {
    $this->conectar($host, $port);
    stream_set_timeout($this->s, 120);
    try {
      list($cod) = $this->resp(); if ($cod !== 220) throw new Exception('El servidor de envío no saludó bien');
      $ehlo = $this->cmd('EHLO ' . DOMINIO_MSGID, 250);
      // Ferozo (12/11/2026) ofrece solo "AUTH LOGIN"; PLAIN se usa si algún día lo ofrece
      if (preg_match('/^250[ -]AUTH[ =][^\r\n]*\bPLAIN\b/mi', $ehlo)) {
        $this->cmd('AUTH PLAIN ' . base64_encode("\0" . $usuario . "\0" . $clave), 235, 'el usuario o la contraseña');
      } else {
        $this->cmd('AUTH LOGIN', 334, 'el método de identificación');
        $this->cmd(base64_encode($usuario), 334, 'el usuario');
        $this->cmd(base64_encode($clave), 235, 'el usuario o la contraseña');
      }
      $this->cmd('MAIL FROM:<' . $remitente . '>', 250);
      foreach ($destinatarios as $d) $this->cmd('RCPT TO:<' . $d . '>', [250, 251], 'el destinatario ' . $d);
      $this->cmd('DATA', 354);
      $m = str_replace(["\r\n", "\r"], "\n", $mensaje);
      $m = preg_replace('/^\./m', '..', $m);   // "dot-stuffing"
      $m = str_replace("\n", "\r\n", $m);
      fwrite($this->s, $m . "\r\n.\r\n");
      list($cod, $txt) = $this->resp();
      if ($cod !== 250) throw new Exception('El servidor de envío no aceptó el correo: ' . trim($txt));
      try { $this->cmd('QUIT', 221); } catch (Throwable $e) { }
    } finally { @fclose($this->s); }
  }
}

/* arranque: el pedido se atiende recién acá, con todas las clases ya definidas */
if (PHP_SAPI !== 'cli') servir();
