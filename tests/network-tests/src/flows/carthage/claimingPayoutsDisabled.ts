import { extendDebug } from '../../Debugger'
import { FixtureRunner } from '../../Fixture'
import { FlowProps } from '../../Flow'
import { BN } from 'bn.js'
import { expect } from 'chai'
import { BondingSucceedsFixture } from '../../fixtures/staking/BondingSucceedsFixture'
import { ClaimingPayoutStakersSucceedsFixture } from '../../fixtures/staking/ClaimingPayoutStakersSucceedsFixture'

export default async function claimingPayoutsDisabled({ api, query, env }: FlowProps): Promise<void> {
  const debug = extendDebug('flow: claiming staking rewards is disabled in PoA ')
  debug('started')
  api.enableDebugTxLogs()

  const nAccounts = 10
  const nBlocks = 10
  const bondAmount = new BN(1000000000)
  const claimingEra = 10

  // create n accounts
  const stakerAccounts = (await api.createKeyPairs(nAccounts)).map(({ key }) => key.address)

  // get authorities
  const authorities = (await api.getSessionAuthorities()).map((account) => account.toString())

  const previousBalances = await Promise.all(stakerAccounts.map((account) => api.getBalance(account)))

  // such accounts becomes stakers
  await Promise.all(
    stakerAccounts.map(async (account) => {
      const bondingSucceedsFixture = new BondingSucceedsFixture(api, {
        stash: account,
        controller: account,
        bondAmount: bondAmount,
      })
      const fixtureRunner = new FixtureRunner(bondingSucceedsFixture)
      fixtureRunner.run()
    })
  )

  // wait k = 10 blocks
  await api.untilBlock(nBlocks)

  // attempt to claim payout for ALL validators
  await Promise.all(
    stakerAccounts.concat(authorities).map(async (account) => {
      const claimingPayoutStakersSucceedsFixture = new ClaimingPayoutStakersSucceedsFixture(api, account, claimingEra)
      const fixtureRunner = new FixtureRunner(claimingPayoutStakersSucceedsFixture)
      fixtureRunner.run()
    })
  )

  const currentBalances = await Promise.all(stakerAccounts.map((account) => api.getBalance(account)))

  // previous balances is equal to current balances
  expect(previousBalances).to.be.deep.equal(currentBalances)
}
