if [ -e .npmrc ]; then
    rm .npmrc
fi
export CODEARTIFACT_AUTH_TOKEN=`aws codeartifact get-authorization-token --domain discovery-dla --domain-owner 504995181951 --query authorizationToken --output text`
cat > .npmrc << EOF
@dla-vod:registry=https://discovery-dla-504995181951.d.codeartifact.us-east-1.amazonaws.com/npm/dla-vod/
//discovery-dla-504995181951.d.codeartifact.us-east-1.amazonaws.com/npm/dla-vod/:always-auth=true
//discovery-dla-504995181951.d.codeartifact.us-east-1.amazonaws.com/npm/dla-vod/:_authToken=${CODEARTIFACT_AUTH_TOKEN}
EOF
npm publish