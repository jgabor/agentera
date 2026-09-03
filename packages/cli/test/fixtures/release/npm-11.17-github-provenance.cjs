// Exact GitHub predicate construction from npm 11.17.0's libnpmpublish 11.2.0.
module.exports = (subject, env) => {
  const relativeRef = (env.GITHUB_WORKFLOW_REF || '').replace(env.GITHUB_REPOSITORY + '/', '')
  const delimiterIndex = relativeRef.indexOf('@')
  const workflowPath = relativeRef.slice(0, delimiterIndex)
  const workflowRef = relativeRef.slice(delimiterIndex + 1)
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject,
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: {
          ref: workflowRef,
          repository: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`,
          path: workflowPath,
        } },
        internalParameters: { github: {
          event_name: env.GITHUB_EVENT_NAME,
          repository_id: env.GITHUB_REPOSITORY_ID,
          repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
        } },
        resolvedDependencies: [{
          uri: `git+${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}@${env.GITHUB_REF}`,
          digest: { gitCommit: env.GITHUB_SHA },
        }],
      },
      runDetails: {
        builder: { id: `https://github.com/actions/runner/${env.RUNNER_ENVIRONMENT}` },
        metadata: {
          invocationId: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
        },
      },
    },
  }
}
