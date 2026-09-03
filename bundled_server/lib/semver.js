// Minimal zero-dependency semantic version comparison.
// Supports "x.y.z" (and optional "-prerelease"). Enough for CLI version gates.

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

function parse(value) {
  if (typeof value !== 'string') throw new TypeError('version must be a string');
  const match = RE.exec(value.trim());
  if (!match) throw new Error(`not a valid semantic version: ${JSON.stringify(value)}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4],
  };
}

// Compare two versions. Returns:
//   -1 if a < b, 0 if a == b, 1 if a > b.
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  // A version with no prerelease is greater than one with a prerelease.
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  if (left.pre !== right.pre) return left.pre < right.pre ? -1 : 1;
  return 0;
}

export function satisfiesGE(version, minVersion) {
  return compareVersions(version, minVersion) >= 0;
}

export function isValid(version) {
  return RE.test(String(version || '').trim());
}