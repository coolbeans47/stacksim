import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate, renderTemplateOrThrow } from "../src/ses/templates.js";

test("SES templates use Handlebars nesting, helpers, escaping, and triple braces", () => {
  const rendered = renderTemplate({
    Subject: "Hello {{user.name}}",
    Text: "{{#if active}}{{user.name}}{{else}}inactive{{/if}}",
    Html: "<p>{{user.name}}</p><div>{{{trustedLocalMarkup}}}</div>",
  }, JSON.stringify({
    user: { name: "<Ada & Grace>" },
    active: true,
    trustedLocalMarkup: "<strong>local</strong>",
  }));

  assert.deepEqual(rendered, {
    content: {
      Subject: "Hello &lt;Ada &amp; Grace&gt;",
      Text: "&lt;Ada &amp; Grace&gt;",
      Html: "<p>&lt;Ada &amp; Grace&gt;</p><div><strong>local</strong></div>",
    },
  });
});

test("missing template data is a post-acceptance rendering outcome while malformed JSON is synchronous", () => {
  const missing = renderTemplate({ Subject: "Hello {{user.name}}" }, "{}");
  assert.equal(missing.content, undefined);
  assert.equal(missing.error?.code, "TEMPLATE_RENDERING_FAILURE");
  assert.match(missing.error?.message ?? "", /not defined|could not be rendered/i);

  assert.throws(
    () => renderTemplateOrThrow({ Subject: "Hello {{name}}" }, "{"),
    (error: any) => error.code === "InvalidParameterValue",
  );
});
