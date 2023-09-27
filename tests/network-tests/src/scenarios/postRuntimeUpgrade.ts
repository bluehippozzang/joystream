import { scenario } from '../Scenario'
import post from '../misc/postRuntimeUpgrade'

// eslint-disable-next-line @typescript-eslint/no-floating-promises
scenario('Full', async ({ job, env, debug }) => {
  // Runtime checks
  job('Post-Upgrade Checks', post)
})
