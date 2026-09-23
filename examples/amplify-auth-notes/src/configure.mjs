// These are public, documented ResourcesConfig fields in the pinned library.
// The CLI output file is consumed unchanged; endpoint overrides are application configuration.
export function configureLocalAuth(Amplify, outputs, controlEndpoint) {
  const local = value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('This learning example requires a loopback endpoint.');
    }
    return url;
  };
  if (!outputs.auth?.user_pool_id || !outputs.auth?.user_pool_client_id) throw new Error('Deploy an Auth fixture first.');
  const control = local(controlEndpoint);
  if (control.pathname !== '/' || control.search || control.hash) throw new Error('Use the StackSim control origin.');
  if (outputs.data?.url) local(outputs.data.url);
  const region = outputs.auth.aws_region;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error('Invalid generated Auth Region.');
  Amplify.configure(outputs);
  const config = Amplify.getConfig();
  Amplify.configure({ ...config, Auth: { ...config.Auth, Cognito: {
    ...config.Auth.Cognito,
    userPoolEndpoint: `${control.origin}/_stacksim/cognito-idp/${region}/sdk`,
    identityPoolEndpoint: `${control.origin}/_stacksim/cognito-identity/${region}/sdk`,
  } } });
}
