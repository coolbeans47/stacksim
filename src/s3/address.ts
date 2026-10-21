/**
 * The bucket of a virtual-hosted-style S3 host, or undefined for a path-style
 * host. Accepts AWS S3 hosts and the loopback forms `<bucket>.s3.localhost`
 * (the local HTTPS endpoint's wildcard name), `<bucket>.localhost`, and
 * `<bucket>.127.0.0.1`. The bare `s3.localhost` endpoint is path style.
 */
export function virtualHostedBucket(host: string): string | undefined {
  return host.match(/^(?!s3\.localhost$)(.+?)\.(?:s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com|s3\.localhost|localhost|127\.0\.0\.1)$/i)?.[1];
}
