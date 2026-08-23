import { panelHeading } from "../components.js";

const help = {
  distributions: {
    level: "CFR-01",
    description: "Distributions are account-global control resources. Canonical CloudFront identity is kept separate from the local loopback viewer endpoint.",
    support: "One private simulator-owned S3 origin, two managed cache policies, viewer-request Functions, security response headers, and explicit invalidation are supported.",
  },
  viewer: {
    level: "Local tooling",
    description: "Each retained distribution owns a stable HTTPS loopback hostname and port. Use the installation CA without changing the canonical DomainName output.",
    support: "StackSim does not publish DNS, bind port 443, install CA trust, or create an ACM certificate. An unavailable listener is shown as degraded.",
  },
  invalidations: {
    level: "CFR-01",
    description: "Invalidations are durable control records. Completion means the bounded local cache crossed the invalidation fence.",
    support: "Exact paths and a final wildcard are supported. CDK BucketDeployment uses /* and waits for completion.",
  },
  functions: {
    level: "Runtime 1.0",
    description: "DEVELOPMENT and LIVE revisions are distinct. Distributions execute only the published LIVE viewer-request revision.",
    support: "Code runs in a fresh bounded QuickJS WASM guest worker. Runtime 2.0, KeyValueStore, viewer-response Functions, and host capabilities remain unavailable.",
  },
  policies: {
    level: "CFR-01 security profile",
    description: "The opening response policy applies CSP, content-type, frame, referrer, and HSTS headers after cache or origin response selection.",
    support: "CORS, custom headers, remove-headers, and server-timing policy sections remain outside CFR-01.",
  },
  oacs: {
    level: "CFR-01 S3 OAC",
    description: "Origin access controls sign the admitted private S3 origin context as the CloudFront service principal.",
    support: "Only s3, always, and sigv4 are supported. OAI, public/custom origins, website endpoints, and external network origins remain unavailable.",
  },
};

const targets = [
  ['.card[data-cloudfront-panel="distributions"]', "Distributions", "distributions"],
  ['.card[data-cloudfront-panel="viewer"]', "Local viewer endpoint", "viewer"],
  ['.card[data-cloudfront-panel="invalidations"]', "Invalidations", "invalidations"],
  ['.card[data-cloudfront-panel="functions"]', "CloudFront Functions", "functions"],
  ['.card[data-cloudfront-panel="policies"]', "Response headers policies", "policies"],
  ['.card[data-cloudfront-panel="oacs"]', "Origin access controls", "oacs"],
];

export function decorateCloudFrontPanelHelp(root = document) {
  for (const [selector, title, key] of targets) {
    const heading = root.querySelector(`${selector} > .card-header h2`);
    if (!heading || heading.closest(".panel-title-row")) continue;
    const meta = heading.querySelector(".muted")?.textContent.trim() ?? "";
    heading.outerHTML = panelHeading(title, help[key], meta);
  }
}

