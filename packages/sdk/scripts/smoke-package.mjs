import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const typescriptCli = resolve(packageDirectory, "../../node_modules/typescript/bin/tsc");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }
  return result.stdout;
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ironside-sdk-package-"));

try {
  const packOutput = run(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    packageDirectory
  );
  const jsonStart = packOutput.indexOf("[");
  if (jsonStart === -1) throw new Error(`npm pack did not return JSON\n${packOutput}`);

  const [packed] = JSON.parse(packOutput.slice(jsonStart));
  if (!packed?.filename || !Array.isArray(packed.files)) {
    throw new Error(`npm pack returned an unexpected result\n${packOutput}`);
  }

  const paths = packed.files.map((file) => file.path);
  const requiredPaths = [
    "package.json",
    "README.md",
    "LICENSE.md",
    "dist/src/index.js",
    "dist/src/index.d.ts"
  ];
  for (const requiredPath of requiredPaths) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`packed package is missing ${requiredPath}`);
    }
  }

  const unexpectedPath = paths.find(
    (path) =>
      path !== "package.json" &&
      path !== "README.md" &&
      path !== "LICENSE.md" &&
      !path.startsWith("dist/src/") &&
      !path.startsWith("src/")
  );
  if (unexpectedPath) throw new Error(`packed package contains unexpected path ${unexpectedPath}`);

  await writeFile(
    join(temporaryDirectory, "package.json"),
    JSON.stringify({ name: "ironside-sdk-package-smoke", private: true, type: "module" })
  );
  await writeFile(
    join(temporaryDirectory, "consumer.mjs"),
    `import { init } from "ironside";
const ironside = init({
  apiKey: "ironside_sc_package_smoke",
  host: "http://localhost:8788",
  fetchImpl: async () => new Response(null, { status: 200 })
});
ironside.trace({ name: "packed-consumer-smoke" });
await ironside.shutdown();
`
  );
  await writeFile(
    join(temporaryDirectory, "consumer.ts"),
    `import {
  init,
  type ScoreOptions,
  type UploadedMedia,
  type UploadMediaOptions
} from "ironside";
const score: ScoreOptions = { name: "quality", value: 1 };
const upload: UploadMediaOptions = {
  data: new Uint8Array([1]),
  contentType: "application/octet-stream"
};
const uploaded: UploadedMedia | undefined = undefined;
void score;
void upload;
void uploaded;
void init;
`
  );
  await writeFile(
    join(temporaryDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false
      },
      include: ["consumer.ts"]
    })
  );

  const tarball = join(temporaryDirectory, packed.filename);
  run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    temporaryDirectory
  );
  run(process.execPath, [typescriptCli, "-p", join(temporaryDirectory, "tsconfig.json")], temporaryDirectory);
  run(process.execPath, [join(temporaryDirectory, "consumer.mjs")], temporaryDirectory);

  console.log(`Packed consumer smoke test passed: ${packed.filename} (${paths.length} files)`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
