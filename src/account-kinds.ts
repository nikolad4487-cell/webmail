export const accountKinds = [
  ['local','Glavni administrator / probni račun'],
  ['staff','Školski djelatnik'],
  ['ednevnik','Učenik · e-Dnevnik'],
  ['formapoint','FormaPoint'],
] as const;
export type AccountKind=typeof accountKinds[number][0];
export const usesUsername=(kind:AccountKind)=>kind==='ednevnik'||kind==='formapoint';
