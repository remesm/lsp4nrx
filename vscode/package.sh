set -e
npx tsc -p client/tsconfig.json
vsce package  --allow-missing-repository

# first time use
# cd vscode (unless you're already there)
# ##  npm install if errors on ci
# npm ci 
