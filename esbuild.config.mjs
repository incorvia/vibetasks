import esbuild from "esbuild";
import process from "process";
import { builtinModules as builtins } from "node:module";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  // Nur im Release minifizieren – im Dev-Build bleibt der Code lesbar (mit Inline-Sourcemap).
  // Zahlt die chrono-Sprachpakete mehr als aus: 971K -> 629K, also kleiner als die 686K, die
  // vorher OHNE chrono ausgeliefert wurden.
  minify: prod,
  treeShaking: true,
  metafile: prod,
  outfile: "main.js",
});

if (prod) {
  const result = await ctx.rebuild();
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
  const forbidden = imports.filter((path) => path.startsWith("node:") || builtins.includes(path));
  if (forbidden.length) throw new Error(`Mobile bundle contains Node built-ins: ${[...new Set(forbidden)].join(", ")}`);
  process.exit(0);
} else {
  await ctx.watch();
}
