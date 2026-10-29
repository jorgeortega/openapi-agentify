# The README's demo GIF: score the example's thin spec, accept the rule-based
# fixes, score it again. Record from the repository root:
#
#   brew install vhs
#   vhs docs/demo.tape
#
# It works on a copy of examples/orders-api in /tmp, so nothing in the
# repository changes. Uses the published package (npx), like a first visit.

Output docs/demo.gif

Require npx

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 720
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

Hide
Type "rm -rf /tmp/orders-api && cp -R examples/orders-api /tmp/orders-api && cd /tmp/orders-api && npm install --silent --no-audit --no-fund && clear"
Enter
Sleep 20s
Show

Type "# A thin OpenAPI spec: what will a model get wrong?"
Enter
Type "npx openapi-agentify check openapi.json | head -12"
Sleep 300ms
Enter
Sleep 5s

Type "# Rule-based fixes, into agentify.tools.json (the spec is untouched)"
Enter
Type "npx openapi-agentify improve --accept"
Sleep 300ms
Enter
Sleep 5s

Type "npx openapi-agentify check openapi.json --tools agentify.tools.json | head -3"
Sleep 300ms
Enter
Sleep 4s

Type "# Serve it: npm start, then /mcp has one tool per operation"
Enter
Sleep 3s
