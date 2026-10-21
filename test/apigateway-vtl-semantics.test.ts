import assert from "node:assert/strict";
import { test } from "node:test";
import { AwsError } from "../src/errors.js";
import { renderVtl, validateVtl, VtlTemplateError, VTL_LIMITS, type VtlContext } from "../src/apigateway-vtl.js";

const source = (overrides: Partial<VtlContext> = {}): VtlContext => ({ body: '{"user":{"name":"Ada","tags":["x","y"],"age":36},"s":"hello world","nothing":null}', headers: { "x-name": "Ada", "content-type": "application/json" }, query: { q: "a b", page: "2" }, path: { id: "42" }, context: { stage: "dev", requestId: "r-1" }, stageVariables: { env: "dev" }, ...overrides });
const render = (template: string, input: VtlContext = source()) => renderVtl(template, input);
const renderError = (template: string, pattern: RegExp, input: VtlContext = source()) => assert.throws(() => renderVtl(template, input), (error: unknown) => error instanceof VtlTemplateError && error instanceof AwsError && error.status === 500 && pattern.test(error.message), template);

test("security: JS internals are unreachable through dot, bracket, get(), #set and JSONPath", () => {
  for (const probe of ["$util.parseJson.constructor('return process.version')()", "#set($x = $util.parseJson.constructor('return process.version'))$x", "$util.constructor", "$input.path.constructor", "$input.constructor.constructor('return 1')", "$input.path('$').user.constructor", "$input.path('$')['__proto__']", "$input.path('$')['constructor']", "$input.path('$').get('constructor')", "$input.path('$').get('__proto__')", "$input.path('$.constructor')", "$input.json('$.user.__proto__')", "$input.path('$..prototype')", "#set($m = {})$m.put('__proto__', 1)", "#set($m = {})#set($m.__proto__ = 1)", "#set($m = {})#set($m['constructor'] = 1)", "$input.body.getClass()", "$input.body.class", "#set($m = {'constructor': 1})", "$context.toString.constructor"]) renderError(probe, /not allowed/);
  assert.equal(render("$input.path('$').toString"), "$input.path('$').toString"); // only own data properties are visible; JS methods are never values
  assert.equal(render("$input.path('$').hasOwnProperty|$util.parseJson|$input.json"), "$input.path('$').hasOwnProperty|$util.parseJson|$input.json");
  renderError("$input.body.foo()", /Unsupported VTL method foo\(\) on String/);
  renderError("$util.toJson($input.body)", /Unsupported VTL method toJson\(\) on \$util/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("budgets: #foreach iterations, output size, string size, collection size, nesting depth", () => {
  renderError("#foreach($i in [1..20000])#end", /maximum of 10000 #foreach iterations/);
  renderError("#foreach($i in [1..6])x#end", /maximum of 5 #foreach iterations/, source({ limits: { maxForeachIterations: 5 } }));
  renderError("#foreach($i in [1..50])0123456789#end", /output exceeded the maximum of 100 characters/, source({ limits: { maxOutputLength: 100 } }));
  renderError("#set($s = 'ab')#foreach($i in [1..40])#set($s = \"$s$s\")#end", /string exceeded the maximum length/);
  renderError("#set($l = [])#foreach($i in [1..5])#foreach($j in [1..4])$!l.add($j)#end#end", /collection exceeded the maximum of 10 elements/, source({ limits: { maxCollectionSize: 10 } }));
  renderError("#set($x = [1..200000])", /range exceeded/);
  const deep = "#if(true)".repeat(VTL_LIMITS.maxDepth + 2) + "x" + "#end".repeat(VTL_LIMITS.maxDepth + 2);
  assert.throws(() => validateVtl(deep), (error: unknown) => error instanceof AwsError && error.code === "BadRequestException" && /nesting/.test(error.message));
  renderError(deep, /nesting/);
  assert.throws(() => validateVtl(`#set($x = ${"(".repeat(500)}1${")".repeat(500)})`), /nesting/);
});

test("references end after their identifier and method/property/index chain", () => {
  assert.equal(render("id-$context.stage-x"), "id-dev-x");
  assert.equal(render("#set($a = 'x')#set($b = 'y')$a/$b|$a$b|$a.$b|$a-$b|($a)|$a,$b|$a:$b|$a;"), "x/y|xy|x.y|x-y|(x)|x,y|x:y|x;");
  assert.equal(render("Action=SendMessage&MessageBody=$util.urlEncode($input.body)&Foo=1", source({ body: "hi there&x=1" })), "Action=SendMessage&MessageBody=hi+there%26x%3D1&Foo=1");
  assert.equal(render("${context.stage}x|$!{nope}y|$!nope|${nope}|$nope.more|$ 5|$|$1|$!|${ x}|cost: $5"), "devx|y||${nope}|$nope.more|$ 5|$|$1|$!|${ x}|cost: $5");
  assert.equal(render("$context.stage.|$context.stage.toUpperCase()!|$input.params('id')'s"), "dev.|DEV!|42's");
  assert.equal(render("$stageVariables['env']|${stageVariables['env']}|$stageVariables.env"), "dev|dev|dev");
  assert.equal(render("\\$context.stage|\\$nope|\\\\$context.stage|\\#if(true)x\\#end"), "$context.stage|\\$nope|\\dev|#if(true)x#end");
  assert.equal(render("a #[[ $raw #if ]]# b"), "a  $raw #if  b");
});

test("validateVtl is parse-only: it never evaluates, but rejects syntax errors and unsupported directives anywhere", () => {
  for (const valid of ["$input.params('q').replace(' ', '+')", "$nothing.foo().bar('x').baz", "#foreach($i in $missing.items())$i.length()#end", "#set($x = $util.parseJson('not json'))", "#set($context.responseOverride.status = 418)#set($context.responseOverride.header.X-Foo = 'a')", "#{if}($a)#{else}#{end}", "#foreach($i in [1..3])#if($i == 2)#break#end#end#stop", "#set($x = 5 / 0)", "Action=SendMessage&MessageBody=$util.urlEncode($input.body)", "$util.parseJson.constructor('x')()"]) assert.doesNotThrow(() => validateVtl(valid), valid);
  const invalid: Array<[string, RegExp]> = [["#if($a)", /#if is missing #end/], ["#end", /#end without a matching/], ["#foreach($i in $list)$i.foo('a'#end", /expected '\)'/], ["#foreach($i in $list)#if($i)x#end", /#foreach is missing #end/], ["#set($a = )", /unexpected '\)'/], ["#set($a)", /expects '='/], ["#set($a.b() = 1)", /method call/], ["#foreach($i $list)#end", /expects 'in'/], ["#foreach($i in [1..3])#else#end", /not allowed/], ["#if(true)#else#else#end", /#else after #else/], ["${a b}", /expected '}'/], ["#set($s = \"abc)", /unterminated string/], ["#* open", /unclosed #\*/], ["$a.b($c $d)", /expected '\)'/], ["#if", /must be followed by \(/]];
  for (const [template, pattern] of invalid) assert.throws(() => validateVtl(template), (error: unknown) => error instanceof AwsError && !(error instanceof VtlTemplateError) && error.code === "BadRequestException" && pattern.test(error.message), template);
  for (const directive of ["macro", "define", "parse", "include", "evaluate"]) assert.throws(() => validateVtl(`#foreach($i in [1])#if(true)#${directive}('x')#end#end`), /unsupported VTL directive/i);
  assert.throws(() => validateVtl("#set($a = \"#macro(x)#end\")"), /unsupported VTL directive/i);
});

test("#set writes dotted targets into the caller's override maps and plain maps", () => {
  const responseOverride = { header: {} as Record<string, unknown> }; const requestOverride = { header: {} as Record<string, unknown>, querystring: {} as Record<string, unknown>, path: {} as Record<string, unknown> };
  const input = source({ context: { stage: "dev", responseOverride, requestOverride } });
  const output = render("#set($context.responseOverride.status = 418)\n#set($context.responseOverride.header.X-Foo = \"bar\")\n#set($context.requestOverride.header.X-Trace-Id = \"t-$input.params('id')\")\n#set($context.requestOverride.querystring.q = 'v')\n#set($context.requestOverride.path.p = 7)\n#set($context.requestOverride.header.multi = ['a', 'b'])\nbody", input);
  assert.equal(output, "body");
  assert.deepEqual(responseOverride, { header: { "X-Foo": "bar" }, status: 418 });
  assert.deepEqual(requestOverride, { header: { "X-Trace-Id": "t-42", multi: ["a", "b"] }, querystring: { q: "v" }, path: { p: 7 } });
  assert.equal(render("#set($context.responseOverride.header['X-Bar'] = 'b')$context.responseOverride.header.get('X-Bar')"), "b");
  const created = source(); render("#set($context.responseOverride.status = 400)", created); assert.equal((created.context.responseOverride as Record<string, unknown>).status, 400);
  renderError("#set($context.responseOverride.status = 400)#set($context.responseOverride.status = 401)", /can only be overridden once/);
  assert.equal(render("#set($m = {})#set($m.a = 1)#set($m.b-c = 2)#set($m['d'] = 3)#set($l = [1, 2])#set($l[0] = 9)#set($l[-1] = 8)$m|$l|$m.a"), "{a=1, b-c=2, d=3}|[9, 8]|1");
  assert.equal(render("#set($x = 'kept')#set($x = $nope)$x|#set($m = {})#set($m.k = $nope)$m.size()"), "kept|0");
  renderError("#set($input.body = 'x')", /Cannot #set/);
  renderError("#set($s = 'str')#set($s.length = 1)", /Cannot #set/);
});

test("String methods follow java.lang.String", () => {
  assert.equal(render("#set($s = '  Hello World  ')$s.length()|$s.trim()|$s.isEmpty()|$s.empty|#set($e = '')$e.isEmpty()|$s.trim().equals('Hello World')|$s.trim().equalsIgnoreCase('hello world')|$s.contains('World')|$s.trim().startsWith('Hell')|$s.trim().startsWith('World', 6)|$s.trim().endsWith('ld')"), "15|Hello World|false|false|true|true|true|true|true|true|true");
  assert.equal(render("#set($s = 'a-b-c')$s.indexOf('-')|$s.indexOf('-', 2)|$s.lastIndexOf('-')|$s.indexOf('z')|$s.replace('-', '+')|$s.replaceAll('[-]', '')|$s.replaceFirst('-', '')|$s.substring(2)|$s.substring(1, 3)|$s.toUpperCase()|$s.toUpperCase().toLowerCase()|$s.charAt(2)|$s.concat('!')|$s.matches('[a-c-]+')|$s.matches('b')"), "1|3|3|-1|a+b+c|abc|ab-c|b-c|-b|A-B-C|a-b-c|b|a-b-c!|true|false");
  assert.equal(render("#set($csv = 'a,b,,c,,')#set($parts = $csv.split(','))$parts.size()|$parts|$parts.get(3)|#set($t = 'a1b22c')$t.split('\\d+')|#set($t = 'x')$t.split(',')|#set($t = 'a,b,c')$t.split(',', 2)"), "4|[a, b, , c]|c|[a, b, c]|[x]|[a, b,c]");
  assert.equal(render("$input.path('$.s').replaceAll('(\\w+) (\\w+)', '$2 $1')|$input.path('$.s').replaceAll('o', '\\$')|$input.path('$.s').replaceAll('(?i)HELLO', 'bye')|#set($t = 'a.b')$t.replaceAll('\\Q.\\E', '!')|#set($t = 'Ab1')$t.replaceAll('\\p{Alpha}', '_')"), "world hello|hell$ w$rld|bye world|a!b|__1");
  assert.equal(render("\"x\" : \"$util.escapeJavaScript(\"it's\").replaceAll(\"\\\\'\",\"'\")\""), "\"x\" : \"it's\""); // the AWS-documented un-escaping idiom
  renderError("#set($t = 'abc')$t.substring(5)", /out of range/);
  renderError("#set($t = 'abc')$t.charAt(3)", /out of range/);
  renderError("#set($t = 'abc')$t.replaceAll('(', '')", /regular expression/);
  renderError("#set($t = 'abc')$t.contains(1)", /expects a String/);
  renderError("#set($t = 'abc')$t.length(1)", /expects 0 argument/);
});

test("Map and List methods, entries and literals", () => {
  assert.equal(render("#set($m = {\"a\": 1, 'b': [1, 2], \"c\": {}})$m|$m.get('a')|$m.a|$m['b']|$m.size()|$m.isEmpty()|$m.containsKey('c')|$m.containsKey('z')|$m.keySet()|$m.values()|$!m.put('d', 'x')|$m.put('d', 'y')|$m.remove('a')|$m.containsValue('y')|$m"), "{a=1, b=[1, 2], c={}}|1|1|[1, 2]|3|false|true|false|[a, b, c]|[1, [1, 2], {}]||x|1|true|{b=[1, 2], c={}, d=y}");
  assert.equal(render("#set($m = {'k1': 'v1', 'k2': 'v2'})#foreach($e in $m.entrySet())$e.key=$e.value/$e.getKey()=$e.getValue();#end|#foreach($v in $m)$v#end|$m.entrySet()"), "k1=v1/k1=v1;k2=v2/k2=v2;|v1v2|[k1=v1, k2=v2]");
  assert.equal(render("#set($l = [])$l.isEmpty()|$l.add('a')|$l.add('b')|#set($ignored = $l.add(0, 'z'))$l|$l.size()|$l.get(1)|$l[0]|$l[-1]|$l.contains('b')|$l.indexOf('b')|$l.remove('z')|$l.remove(0)|$l|$l.empty"), "true|true|true|[z, a, b]|3|a|z|b|true|2|true|a|[b]|false");
  assert.equal(render("#set($r = [1..3])$r|#set($r = [3..1])$r|#set($n = 2)#set($r = [1..$n])$r|#set($r = [-1..1])$r|#set($l = [1, 'two', true, {'k': [3]}])$l|#set($e = {})$e|#set($e = [])$e"), "[1, 2, 3]|[3, 2, 1]|[1, 2]|[-1, 0, 1]|[1, two, true, {k=[3]}]|{}|[]");
  renderError("#set($l = [1])$l.get(5)", /out of bounds/);
  renderError("#set($m = {})$m.frob()", /Unsupported VTL method frob\(\) on Map/);
  renderError("#set($l = [])$l.frob()", /Unsupported VTL method frob\(\) on List/);
});

test("directives: braced forms, comments, #foreach scope variables, #break and #stop", () => {
  assert.equal(render("#{if}(false)A#{elseif}(true)B#{else}C#{end}|#{foreach}($i in [1, 2])$i#{end}|#{set}($x = 3)$x|a#{if}(true)b#{end}c"), "B|12|3|abc");
  assert.equal(render("a#* block\n comment $nope #if *#b## line comment\nc"), "abc");
  assert.equal(render("#foreach($i in ['x', 'y', 'z'])$velocityCount:$foreach.index:$foreach.count:$foreach.hasNext:$foreach.first:$foreach.last:$i;#end|$!velocityCount|$!i"), "1:0:1:true:true:false:x;2:1:2:true:false:false:y;3:2:3:false:false:true:z;||");
  assert.equal(render("#set($i = 'outer')#foreach($i in [1, 2])#foreach($j in ['a', 'b'])$foreach.parent.count$j$velocityCount #end#end|$i"), "1a1 1b2 2a1 2b2 |outer");
  assert.equal(render("#foreach($i in [1..5])#if($i == 3)#break#end$i#end|#foreach($i in [1, 2])#foreach($j in [1, 2])#break($foreach.parent)#end$i#end|done"), "12||done");
  assert.equal(render("a#if(true)b#stop c#end d"), "ab");
  assert.equal(render("#set($x = 'a')#if(true)#set($x = 'b')#end$x"), "b"); // one Velocity context: #set inside a block stays visible
  assert.equal(render("#if(true)\n  a\n#end\nb\n  #set($x = 1)\nc"), "  a\nb\nc"); // Velocity 1.7 gobbles the newline after directives and the indentation before #set
  assert.equal(render("#foreach($k in $input.path('$.user'))$k;#end|#foreach($t in $input.path('$.user.tags'))$t#end|#foreach($n in $nope)x#end"), "Ada;[\"x\",\"y\"];36;|xy|");
});

test("expressions: quoted interpolation, integer arithmetic, comparisons and truthiness", () => {
  assert.equal(render("#set($pk = \"USER#$input.params('id')\")$pk|#set($raw = 'USER#$input.params(\"id\")')$raw|#set($q = \"say \"\"hi\"\" ${context.stage}\")$q|#set($n = \"#if(true)yes#end\")$n|#set($m = \"$nope\")$m"), "USER#42|USER#$input.params(\"id\")|say \"hi\" dev|yes|$nope");
  assert.equal(render("#set($a = 5 / 2)$a|#set($a = 5.5 / 2)$a|#set($a = -7 / 2)$a|#set($a = 7 % 3)$a|#set($a = 2 * 3 + 1)$a|#set($a = 2 * (3 + 1))$a|#set($a = 1.5 + 1)$a|#set($a = 10 - 2 - 3)$a|#set($a = 'n' + 1)$a|#set($b = 5 / 0)$!b"), "2|2.75|-3|1|7|8|2.5|5|n1|");
  assert.equal(render("#if(1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3 && 1 != 2 && !false)ok#end|#if(1 lt 2 and not false or false)ok#end|#if('2' == 2)eq#end|#if($input.params('page') == 2)eq#end|#if([1, 2] == [1, 2])eq#end|#if($nope == $nope2)nulls#end|#if('a' < 'b')bad#{else}nan#end"), "ok|ok|eq|eq|eq|nulls|nan");
  assert.equal(render("#if('')empty-string-is-true#end|#if(0)zero-is-true#end|#if([])empty-list-is-true#end|#if($nope)x#{else}null-is-false#end|#if(false)x#{else}false-is-false#end|#if(!$nope)negated#end"), "empty-string-is-true|zero-is-true|empty-list-is-true|null-is-false|false-is-false|negated");
});

test("$input and $util follow the API Gateway reference", () => {
  assert.equal(render("$input.path('$.user')|$input.json('$.user')|$input.path('$.user.tags')|$input.json('$.user.tags[0]')|$input.path('$.user.tags').size()|$input.path('$.user.name').length()"), "{name=Ada, tags=[\"x\",\"y\"], age=36}|{\"name\":\"Ada\",\"tags\":[\"x\",\"y\"],\"age\":36}|[\"x\",\"y\"]|\"x\"|2|3");
  assert.equal(render("[$input.json('$.missing')][$input.path('$.missing')][$input.json('$.nothing')][$input.path('$.user.missing.deep')]"), "[\"\"][][\"\"][]");
  assert.equal(render("$input.path('$..name')|$input.json('$.user.tags[*]')|$input.path('$.user.tags[-1]')|$input.path('$[\"user\"][\"age\"]')|$input.path('user.name')|$input.json('$.user.tags[0:1]')"), "[\"Ada\"]|[\"x\",\"y\"]|y|36|Ada|[\"x\"]");
  assert.equal(render("$input.params('id')|$input.params('q')|$input.params('X-Name')|[$input.params('missing')]|$input.params().path.id|$input.params().querystring|$input.params.header.get('x-name')"), "42|a b|Ada|[]|42|{q=a b, page=2}|Ada");
  assert.equal(render("$input.body|$input.json('$')|$input.path('$').size()", source({ body: "" })), "{}|{}|0");
  renderError("$input.path('$.a')", /not valid JSON/, source({ body: "not json" }));
  assert.equal(render("$input.body", source({ body: "not json" })), "not json");
  renderError("$input.path('$[?(@.a)]')", /filter expressions/);
  assert.equal(render("$util.escapeJavaScript(\"it's \"\"q\"\" a/b \\ é\")|$util.escapeJavaScript($nope)"), "it\\'s \\\"q\\\" a\\/b \\\\ \\u00E9|null");
  assert.equal(render("$util.urlEncode(\"a b&c=d/é~!*'()\")|$util.urlDecode('a+b%26c')|$util.base64Encode('hé')|$util.base64Decode('aMOp')"), "a+b%26c%3Dd%2F%C3%A9%7E%21*%27%28%29|a b&c|aMOp|hé");
  assert.equal(render("#set($o = $util.parseJson('{\"a\":{\"b\":[1,2]},\"n\":1.5}'))$o.a.b[1]|$o.a|$o.n|$o|#set($l = $util.parseJson('[1,\"x\"]'))$l|$l.size()"), "2|{b=[1,2]}|1.5|{a={b=[1,2]}, n=1.5}|[1,\"x\"]|2");
  renderError("$util.parseJson('{bad')", /not valid JSON/);
  renderError("$util.base64Decode('***')", /not valid base64/);
  renderError("$util.urlDecode('%zz')", /malformed/);
  renderError("$util.urlEncode($nope)", /null argument/);
  assert.throws(() => renderVtl("$util.parseJson('{bad')", source()), (error: unknown) => error instanceof VtlTemplateError && !/SyntaxError|JSON\.parse|position \d/.test(error.message));
});

test("parse and runtime failures at render time are VtlTemplateError (500)", () => {
  renderError("#if($a)", /#if is missing #end/);
  renderError("#macro(x)#end", /unsupported VTL directive/i);
  renderError("#set($l = [1])$l[3]", /out of bounds/);
  const error = new VtlTemplateError("boom"); assert.equal(error.name, "VtlTemplateError"); assert.equal(error.code, "InternalServerErrorException"); assert.equal(error.status, 500); assert.ok(error instanceof Error);
});
