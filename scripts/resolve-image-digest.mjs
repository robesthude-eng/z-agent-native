import fs from "node:fs";

// One local image can have digests from several repositories. Only attest and
// deploy the exact registry repository that was pushed and pulled by this run.
const repository = process.argv[2];
try {
  if (!repository || repository.includes("@") || repository.includes(":")) {
    throw new Error("Expected a registry repository without tag or digest");
  }
  const values = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!Array.isArray(values)) throw new Error("RepoDigests must be an array");
  const matches = [
    ...new Set(
      values.filter(
        (value) =>
          typeof value === "string" &&
          value.startsWith(`${repository}@`) &&
          /^sha256:[a-f0-9]{64}$/.test(value.slice(repository.length + 1)),
      ),
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one verified digest for ${repository}; found ${matches.length}`,
    );
  }
  console.log(matches[0]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
