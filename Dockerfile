# The example Orders API as a stdio MCP server (examples/orders-api/stdio.ts).
# Glama builds and introspects this; it is not part of the npm package.
#
#   docker build -t openapi-agentify-demo .
#   docker run -i --rm openapi-agentify-demo
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
CMD ["node", "--import", "tsx", "examples/orders-api/stdio.ts"]
