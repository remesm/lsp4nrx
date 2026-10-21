set -e
npx tsc -p client/tsconfig.json
vsce package  --allow-missing-repository
