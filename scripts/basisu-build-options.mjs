// CMake bracket arguments preserve literal paths without variable expansion.
export function cmakeLiteral(value) {
  let equals = "";
  while (value.includes(`]${equals}]`)) equals += "=";
  return `[${equals}[${value}]${equals}]`;
}

// CMake writes flag strings into a POSIX compiler command. Quote each whole
// argument, rather than only the path fragment, before that second parsing.
export function compilerArgument(value) {
  return /^[a-z\d_./:=+,\-]+$/i.test(value) ? value : `"${value.replace(/[\\"$`]/g, character => `\\${character}`)}"`;
}

export function basisuReleaseFlags(source) {
  return ["-O2", "-DNDEBUG", `-ffile-prefix-map=${source}=basis_universal`, `-fmacro-prefix-map=${source}=basis_universal`].map(compilerArgument).join(" ");
}
