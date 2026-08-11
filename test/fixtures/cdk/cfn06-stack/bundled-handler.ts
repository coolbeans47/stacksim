declare const __CFN06_RELEASE_V2__: boolean;

export async function handler(event: unknown): Promise<Record<string, unknown>> {
  const release = __CFN06_RELEASE_V2__ ? "v2" : "v1";
  console.log(`cfn06 bundled ${release}`);
  return {
    kind: "bundled",
    release,
    event,
  };
}
