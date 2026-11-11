// Regla vigente de compras-ml (11/11/2026), aplicada al nombre declarado.
// No cambia el orden de nombres/apellidos ni el nombre comercial de una marca.
const MINUS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "con", "para", "por", "a"]);
const ACENTOS: Record<string, string> = {
  maria: "María", jose: "José", rodriguez: "Rodríguez", gonzalez: "González", martinez: "Martínez", lopez: "López", gomez: "Gómez",
  fernandez: "Fernández", perez: "Pérez", sanchez: "Sánchez", ramirez: "Ramírez", diaz: "Díaz", alvarez: "Álvarez", gimenez: "Giménez",
  jimenez: "Jiménez", benitez: "Benítez", hernandez: "Hernández", dominguez: "Domínguez", nuñez: "Núñez", nunez: "Núñez", suarez: "Suárez",
  vazquez: "Vázquez", velazquez: "Velázquez", gutierrez: "Gutiérrez", juarez: "Juárez", mendez: "Méndez", ruiz: "Ruiz", garcia: "García",
  belen: "Belén", ines: "Inés", ramon: "Ramón", martin: "Martín", julian: "Julián", sebastian: "Sebastián", lucia: "Lucía", sofia: "Sofía",
  angel: "Ángel", andres: "Andrés", ruben: "Rubén", german: "Germán", hector: "Héctor", oscar: "Óscar", victor: "Víctor", raul: "Raúl",
  joaquin: "Joaquín", agustin: "Agustín", nicolas: "Nicolás", tomas: "Tomás", matias: "Matías", ivan: "Iván", cesar: "César", adrian: "Adrián",
  quimica: "Química", quimicos: "Químicos", drogueria: "Droguería", electronica: "Electrónica", plastico: "Plástico", plasticos: "Plásticos",
  informatico: "Informático", informatica: "Informática", organizacion: "Organización", distribucion: "Distribución", logistica: "Logística",
  tecnologia: "Tecnología", comercializacion: "Comercialización", produccion: "Producción", argentina: "Argentina", union: "Unión",
  farmacia: "Farmacia", farmaceutica: "Farmacéutica", cosmetica: "Cosmética", industria: "Industria", fabrica: "Fábrica", grafica: "Gráfica",
  aguila: "Águila", electrica: "Eléctrica", optica: "Óptica", economica: "Económica", tecnica: "Técnica", medica: "Médica",
  damian: "Damián", fabian: "Fabián", junin: "Junín", peron: "Perón", lanus: "Lanús", catan: "Catán", dominico: "Domínico", velez: "Vélez",
  dean: "Deán", cordoba: "Córdoba", tucuman: "Tucumán", neuquen: "Neuquén", constitucion: "Constitución", belgrano: "Belgrano", rios: "Ríos",
  sarmiento: "Sarmiento", moron: "Morón", ituzaingo: "Ituzaingó",
  // marcas con mayúsculas propias
  eyg: "EyG", fravega: "Frávega", parana: "Paraná",
};
const SOCIEDAD: [RegExp, string][] = [
  [/\bSOCIEDAD ANONIMA COMERCIAL E INDUSTRIAL\b/g, "S.A.C.I."], [/\bSOCIEDAD ANONIMA\b/g, "S.A."],
  [/\bSOCIEDAD DE RESPONSABILIDAD LIMITADA\b/g, "S.R.L."], [/\bS\.?\s?A\.?\s?C\.?\s?I\.?\s?E\.?\s?I\.?(?=\s|$)/g, "S.A.C.I.E.I."], [/\bSOCIEDAD POR ACCIONES SIMPLIFICADA\b/g, "S.A.S."],
  [/\bS\.?\s?R\.?\s?L\.?(?=\s|$)/g, "S.R.L."], [/\bS\.?\s?A\.?\s?S\.?(?=\s|$)/g, "S.A.S."], [/\bS\.?\s?A\.?\s?C\.?\s?I\.?(?=\s|$)/g, "S.A.C.I."],
  [/\bS\.?\s?A\.?(?=\s|$)/g, "S.A."], [/\bS\.?\s?C\.?(?=\s|$)/g, "S.C."],
];
function palabra(w: string, i: number): string {
  if (/^[A-Z]\.([A-Z]\.)+$/.test(w)) return w;                       // S.A., S.R.L.
  const l = w.toLowerCase();
  if (i > 0 && MINUS.has(l)) return l;
  if (/^[^aeiouáéíóú]{2,4}$/i.test(w) && /[A-Z]/.test(w)) return w.toUpperCase(); // siglas sin vocales (YPF)
  if (ACENTOS[l]) return ACENTOS[l];
  return l.split("-").map((p) => p ? p[0].toUpperCase() + p.slice(1) : p).join("-");
}
export function tipoOracion(s: string): string {
  let t = String(s || "").toUpperCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
  for (const [re, rep] of SOCIEDAD) t = t.replace(re, rep);
  return t.split(" ").map((w, i) => palabra(w, i)).join(" ");
}
