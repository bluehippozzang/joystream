import { Api } from '../Api'
import BN from 'bn.js'
import { assert } from 'chai'
import { BaseQueryNodeFixture } from '../Fixture'
import { MemberId } from '@joystream/types/common'
import { QueryNodeApi } from '../QueryNodeApi'
import { BuyMembershipParameters, Membership } from '@joystream/types/members'
import { EventType, MembershipEntryMethod } from '../graphql/generated/schema'
import { blake2AsHex } from '@polkadot/util-crypto'
import { SubmittableExtrinsic } from '@polkadot/api/types'
import { CreateInterface, createType } from '@joystream/types'
import { MembershipMetadata } from '@joystream/metadata-protobuf'
import {
  MemberContext,
  AnyQueryNodeEvent,
  EventDetails,
  MemberInvitedEventDetails,
  MembershipBoughtEventDetails,
  MembershipEventName,
} from '../types'
import {
  InvitesTransferredEventFieldsFragment,
  MemberAccountsUpdatedEventFieldsFragment,
  MemberInvitedEventFieldsFragment,
  MemberProfileUpdatedEventFieldsFragment,
  MembershipBoughtEventFieldsFragment,
  MembershipFieldsFragment,
  MembershipSystemSnapshotFieldsFragment,
  StakingAccountAddedEventFieldsFragment,
  StakingAccountConfirmedEventFieldsFragment,
  StakingAccountRemovedEventFieldsFragment,
} from '../graphql/generated/queries'

// FIXME: Retrieve from runtime when possible!
const MINIMUM_STAKING_ACCOUNT_BALANCE = 200

// common code for fixtures
// TODO: Refactor to use StandardizedFixture?
abstract class BaseMembershipFixture extends BaseQueryNodeFixture {
  generateParamsFromAccountId(accountId: string): CreateInterface<BuyMembershipParameters> {
    const metadata = new MembershipMetadata()
    metadata.setName(`name${accountId.substring(0, 14)}`)
    metadata.setAbout(`about${accountId.substring(0, 14)}`)
    // TODO: avatar
    return {
      root_account: accountId,
      controller_account: accountId,
      handle: `handle${accountId.substring(0, 14)}`,
      metadata: createType('Bytes', '0x' + Buffer.from(metadata.serializeBinary()).toString('hex')),
    }
  }
}

export class BuyMembershipHappyCaseFixture extends BaseMembershipFixture {
  private accounts: string[]
  private memberIds: MemberId[] = []

  private extrinsics: SubmittableExtrinsic<'promise'>[] = []
  private events: MembershipBoughtEventDetails[] = []
  private members: Membership[] = []

  public constructor(api: Api, query: QueryNodeApi, accounts: string[]) {
    super(api, query)
    this.accounts = accounts
  }

  private generateBuyMembershipTx(accountId: string): SubmittableExtrinsic<'promise'> {
    return this.api.tx.members.buyMembership(this.generateParamsFromAccountId(accountId))
  }

  public getCreatedMembers(): MemberId[] {
    return this.memberIds.slice()
  }

  private assertMemberMatchQueriedResult(member: Membership, qMember: MembershipFieldsFragment | null) {
    if (!qMember) {
      throw new Error('Query node: Membership not found!')
    }
    const {
      handle,
      rootAccount,
      controllerAccount,
      metadata: { name, about },
      isVerified,
      entry,
    } = qMember
    const txParams = this.generateParamsFromAccountId(rootAccount)
    const metadata = MembershipMetadata.deserializeBinary(txParams.metadata.toU8a(true))
    assert.equal(blake2AsHex(handle), member.handle_hash.toString())
    assert.equal(handle, txParams.handle)
    assert.equal(rootAccount, member.root_account.toString())
    assert.equal(controllerAccount, member.controller_account.toString())
    assert.equal(name, metadata.getName())
    assert.equal(about, metadata.getAbout())
    // TODO: avatar
    assert.equal(isVerified, false)
    assert.equal(entry, MembershipEntryMethod.Paid)
  }

  private assertEventMatchQueriedResult(
    eventDetails: MembershipBoughtEventDetails,
    account: string,
    txHash: string,
    qEvent: MembershipBoughtEventFieldsFragment | null
  ) {
    if (!qEvent) {
      throw new Error('Query node: MembershipBought event not found!')
    }
    const txParams = this.generateParamsFromAccountId(account)
    const metadata = MembershipMetadata.deserializeBinary(txParams.metadata.toU8a(true))
    assert.equal(qEvent.event.inBlock.number, eventDetails.blockNumber)
    assert.equal(qEvent.event.inExtrinsic, txHash)
    assert.equal(qEvent.event.indexInBlock, eventDetails.indexInBlock)
    assert.equal(qEvent.event.type, EventType.MembershipBought)
    assert.equal(qEvent.newMember.id, eventDetails.memberId.toString())
    assert.equal(qEvent.handle, txParams.handle)
    assert.equal(qEvent.rootAccount, txParams.root_account.toString())
    assert.equal(qEvent.controllerAccount, txParams.controller_account.toString())
    assert.equal(qEvent.metadata.name, metadata.getName())
    assert.equal(qEvent.metadata.about, metadata.getAbout())
    // TODO: avatar
  }

  async execute(): Promise<void> {
    // Fee estimation and transfer
    const membershipFee = await this.api.getMembershipFee()
    const membershipTransactionFee = await this.api.estimateTxFee(
      this.generateBuyMembershipTx(this.accounts[0]),
      this.accounts[0]
    )
    const estimatedFee = membershipTransactionFee.add(new BN(membershipFee))

    await this.api.treasuryTransferBalanceToAccounts(this.accounts, estimatedFee)

    this.extrinsics = this.accounts.map((a) => this.generateBuyMembershipTx(a))
    const results = await Promise.all(this.accounts.map((a, i) => this.api.signAndSend(this.extrinsics[i], a)))
    this.events = await Promise.all(results.map((r) => this.api.retrieveMembershipBoughtEventDetails(r)))
    this.memberIds = this.events.map((e) => e.memberId)

    this.debug(`Registered ${this.memberIds.length} new members`)

    assert.equal(this.memberIds.length, this.accounts.length)

    // Assert that created members have expected root and controller accounts
    this.members = await Promise.all(this.memberIds.map((id) => this.api.query.members.membershipById(id)))

    this.members.forEach((member, index) => {
      assert(member.root_account.eq(this.accounts[index]))
      assert(member.controller_account.eq(this.accounts[index]))
    })
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    // Ensure newly created members were parsed by query node
    await Promise.all(
      this.members.map(async (member, i) => {
        const memberId = this.memberIds[i]
        await this.query.tryQueryWithTimeout(
          () => this.query.getMemberById(memberId),
          (qMember) => this.assertMemberMatchQueriedResult(member, qMember)
        )
        // Ensure the query node event is valid
        const qEvent = await this.query.getMembershipBoughtEvent(memberId)
        this.assertEventMatchQueriedResult(this.events[i], this.accounts[i], this.extrinsics[i].hash.toString(), qEvent)
      })
    )
  }
}

export class BuyMembershipWithInsufficienFundsFixture extends BaseMembershipFixture {
  private account: string

  public constructor(api: Api, query: QueryNodeApi, account: string) {
    super(api, query)
    this.account = account
  }

  private generateBuyMembershipTx(accountId: string): SubmittableExtrinsic<'promise'> {
    return this.api.tx.members.buyMembership(this.generateParamsFromAccountId(accountId))
  }

  async execute(): Promise<void> {
    // It is acceptable for same account to register a new member account
    // So no need to assert that account is not already used as a controller or root for another member
    // const membership = await this.api.getMemberIds(this.account)
    // assert(membership.length === 0, 'Account must not be associated with a member')

    // Fee estimation and transfer
    const membershipFee: BN = await this.api.getMembershipFee()
    const membershipTransactionFee: BN = await this.api.estimateTxFee(
      this.generateBuyMembershipTx(this.account),
      this.account
    )

    // Only provide enough funds for transaction fee but not enough to cover the membership fee
    await this.api.treasuryTransferBalance(this.account, membershipTransactionFee)

    const balance = await this.api.getBalance(this.account)

    assert.isBelow(
      balance.toNumber(),
      membershipFee.add(membershipTransactionFee).toNumber(),
      'Account already has sufficient balance to purchase membership'
    )

    const result = await this.api.signAndSend(this.generateBuyMembershipTx(this.account), this.account)

    this.expectDispatchError(result, 'Buying membership with insufficient funds should fail.')

    // Assert that failure occured for expected reason
    assert.equal(this.api.getErrorNameFromExtrinsicFailedRecord(result), 'NotEnoughBalanceToBuyMembership')
  }
}

// TODO: Add partial update to make sure it works too
export class UpdateProfileHappyCaseFixture extends BaseMembershipFixture {
  private memberContext: MemberContext
  // Update data
  private newName = 'New name'
  private newHandle = 'New handle'
  private newAbout = 'New about'

  private event?: EventDetails
  private tx?: SubmittableExtrinsic<'promise'>

  public constructor(api: Api, query: QueryNodeApi, memberContext: MemberContext) {
    super(api, query)
    this.memberContext = memberContext
  }

  private assertProfileUpdateSuccesful(qMember: MembershipFieldsFragment | null) {
    if (!qMember) {
      throw new Error('Query node: Membership not found!')
    }
    const {
      handle,
      metadata: { name, about },
    } = qMember
    assert.equal(name, this.newName)
    assert.equal(handle, this.newHandle)
    // TODO: avatar
    assert.equal(about, this.newAbout)
  }

  private assertQueryNodeEventIsValid(
    eventDetails: EventDetails,
    txHash: string,
    qEvents: MemberProfileUpdatedEventFieldsFragment[]
  ) {
    const qEvent = this.findMatchingQueryNodeEvent(eventDetails, qEvents)
    const {
      event: { inExtrinsic, type },
      member: { id: memberId },
      newHandle,
      newMetadata,
    } = qEvent
    assert.equal(inExtrinsic, txHash)
    assert.equal(type, EventType.MemberProfileUpdated)
    assert.equal(memberId, this.memberContext.memberId.toString())
    assert.equal(newHandle, this.newHandle)
    assert.equal(newMetadata.name, this.newName)
    assert.equal(newMetadata.about, this.newAbout)
    // TODO: avatar
  }

  async execute(): Promise<void> {
    const metadata = new MembershipMetadata()
    metadata.setName(this.newName)
    metadata.setAbout(this.newAbout)
    // TODO: avatar
    this.tx = this.api.tx.members.updateProfile(
      this.memberContext.memberId,
      this.newHandle,
      '0x' + Buffer.from(metadata.serializeBinary()).toString('hex')
    )
    const txFee = await this.api.estimateTxFee(this.tx, this.memberContext.account)
    await this.api.treasuryTransferBalance(this.memberContext.account, txFee)
    const txRes = await this.api.signAndSend(this.tx, this.memberContext.account)
    this.event = await this.api.retrieveMembershipEventDetails(txRes, 'MemberProfileUpdated')
  }

  async runQueryNodeChecks() {
    await super.runQueryNodeChecks()
    await this.query.tryQueryWithTimeout(
      () => this.query.getMemberById(this.memberContext.memberId),
      (qMember) => this.assertProfileUpdateSuccesful(qMember)
    )
    const qEvents = await this.query.getMemberProfileUpdatedEvents(this.memberContext.memberId)
    this.assertQueryNodeEventIsValid(this.event!, this.tx!.hash.toString(), qEvents)
  }
}

export class UpdateAccountsHappyCaseFixture extends BaseMembershipFixture {
  private memberContext: MemberContext
  // Update data
  private newRootAccount: string
  private newControllerAccount: string

  private tx?: SubmittableExtrinsic<'promise'>
  private event?: EventDetails

  public constructor(
    api: Api,
    query: QueryNodeApi,
    memberContext: MemberContext,
    newRootAccount: string,
    newControllerAccount: string
  ) {
    super(api, query)
    this.memberContext = memberContext
    this.newRootAccount = newRootAccount
    this.newControllerAccount = newControllerAccount
  }

  private assertAccountsUpdateSuccesful(qMember: MembershipFieldsFragment | null) {
    if (!qMember) {
      throw new Error('Query node: Membership not found!')
    }
    const { rootAccount, controllerAccount } = qMember
    assert.equal(rootAccount, this.newRootAccount)
    assert.equal(controllerAccount, this.newControllerAccount)
  }

  private assertQueryNodeEventIsValid(
    eventDetails: EventDetails,
    txHash: string,
    qEvents: MemberAccountsUpdatedEventFieldsFragment[]
  ) {
    const qEvent = this.findMatchingQueryNodeEvent(eventDetails, qEvents)
    const {
      event: { inExtrinsic, type },
      member: { id: memberId },
      newControllerAccount,
      newRootAccount,
    } = qEvent
    assert.equal(inExtrinsic, txHash)
    assert.equal(type, EventType.MemberAccountsUpdated)
    assert.equal(memberId, this.memberContext.memberId.toString())
    assert.equal(newControllerAccount, this.newControllerAccount)
    assert.equal(newRootAccount, this.newRootAccount)
  }

  async execute(): Promise<void> {
    this.tx = this.api.tx.members.updateAccounts(
      this.memberContext.memberId,
      this.newRootAccount,
      this.newControllerAccount
    )
    const txFee = await this.api.estimateTxFee(this.tx, this.memberContext.account)
    await this.api.treasuryTransferBalance(this.memberContext.account, txFee)
    const txRes = await this.api.signAndSend(this.tx, this.memberContext.account)
    this.event = await this.api.retrieveMembershipEventDetails(txRes, 'MemberAccountsUpdated')
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    await this.query.tryQueryWithTimeout(
      () => this.query.getMemberById(this.memberContext.memberId),
      (qMember) => this.assertAccountsUpdateSuccesful(qMember)
    )
    const qEvents = await this.query.getMemberAccountsUpdatedEvents(this.memberContext.memberId)
    this.assertQueryNodeEventIsValid(this.event!, this.tx!.hash.toString(), qEvents)
  }
}

export class InviteMembersHappyCaseFixture extends BaseMembershipFixture {
  private inviterContext: MemberContext
  private accounts: string[]

  private initialInvitesCount?: number
  private extrinsics: SubmittableExtrinsic<'promise'>[] = []
  private events: MemberInvitedEventDetails[] = []

  public constructor(api: Api, query: QueryNodeApi, inviterContext: MemberContext, accounts: string[]) {
    super(api, query)
    this.inviterContext = inviterContext
    this.accounts = accounts
  }

  generateInviteMemberTx(memberId: MemberId, inviteeAccountId: string): SubmittableExtrinsic<'promise'> {
    return this.api.tx.members.inviteMember({
      ...this.generateParamsFromAccountId(inviteeAccountId),
      inviting_member_id: memberId,
    })
  }

  private assertMemberCorrectlyInvited(account: string, qMember: MembershipFieldsFragment | null) {
    if (!qMember) {
      throw new Error('Query node: Membership not found!')
    }
    const {
      handle,
      rootAccount,
      controllerAccount,
      metadata: { name, about },
      isVerified,
      entry,
      invitedBy,
    } = qMember
    const txParams = this.generateParamsFromAccountId(account)
    const metadata = MembershipMetadata.deserializeBinary(txParams.metadata.toU8a(true))
    assert.equal(handle, txParams.handle)
    assert.equal(rootAccount, txParams.root_account)
    assert.equal(controllerAccount, txParams.controller_account)
    assert.equal(name, metadata.getName())
    assert.equal(about, metadata.getAbout())
    // TODO: avatar
    assert.equal(isVerified, false)
    assert.equal(entry, MembershipEntryMethod.Invited)
    assert.isOk(invitedBy)
    assert.equal(invitedBy!.id, this.inviterContext.memberId.toString())
  }

  private aseertQueryNodeEventIsValid(
    eventDetails: MemberInvitedEventDetails,
    account: string,
    txHash: string,
    qEvent: MemberInvitedEventFieldsFragment | null
  ) {
    if (!qEvent) {
      throw new Error('Query node: MemberInvitedEvent not found!')
    }
    const txParams = this.generateParamsFromAccountId(account)
    const metadata = MembershipMetadata.deserializeBinary(txParams.metadata.toU8a(true))
    assert.equal(qEvent.event.inBlock.number, eventDetails.blockNumber)
    assert.equal(qEvent.event.inExtrinsic, txHash)
    assert.equal(qEvent.event.indexInBlock, eventDetails.indexInBlock)
    assert.equal(qEvent.event.type, EventType.MemberInvited)
    assert.equal(qEvent.newMember.id, eventDetails.newMemberId.toString())
    assert.equal(qEvent.handle, txParams.handle)
    assert.equal(qEvent.rootAccount, txParams.root_account)
    assert.equal(qEvent.controllerAccount, txParams.controller_account)
    assert.equal(qEvent.metadata.name, metadata.getName())
    assert.equal(qEvent.metadata.about, metadata.getAbout())
    // TODO: avatar
  }

  async execute(): Promise<void> {
    this.extrinsics = this.accounts.map((a) => this.generateInviteMemberTx(this.inviterContext.memberId, a))
    const feePerTx = await this.api.estimateTxFee(this.extrinsics[0], this.inviterContext.account)
    await this.api.treasuryTransferBalance(this.inviterContext.account, feePerTx.muln(this.accounts.length))

    const initialInvitationBalance = await this.api.query.members.initialInvitationBalance()
    // Top up working group budget to allow funding invited members
    await this.api.makeSudoCall(
      this.api.tx.membershipWorkingGroup.setBudget(initialInvitationBalance.muln(this.accounts.length))
    )

    const { invites } = await this.api.query.members.membershipById(this.inviterContext.memberId)
    this.initialInvitesCount = invites.toNumber()

    const txResults = await Promise.all(
      this.extrinsics.map((tx) => this.api.signAndSend(tx, this.inviterContext.account))
    )
    this.events = await Promise.all(txResults.map((res) => this.api.retrieveMemberInvitedEventDetails(res)))
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    const invitedMembersIds = this.events.map((e) => e.newMemberId)
    await Promise.all(
      this.accounts.map(async (account, i) => {
        const memberId = invitedMembersIds[i]
        await this.query.tryQueryWithTimeout(
          () => this.query.getMemberById(memberId),
          (qMember) => this.assertMemberCorrectlyInvited(account, qMember)
        )
        const qEvent = await this.query.getMemberInvitedEvent(memberId)
        this.aseertQueryNodeEventIsValid(this.events[i], account, this.extrinsics[i].hash.toString(), qEvent)
      })
    )

    const qInviter = await this.query.getMemberById(this.inviterContext.memberId)
    if (!qInviter) {
      throw new Error('Query node: Inviter member not found!')
    }
    const { inviteCount, invitees } = qInviter
    // Assert that inviteCount was correctly updated
    assert.equal(inviteCount, this.initialInvitesCount! - this.accounts.length)
    // Assert that all invited members are part of "invetees" field
    assert.isNotEmpty(invitees)
    assert.includeMembers(
      invitees.map(({ id }) => id),
      invitedMembersIds.map((id) => id.toString())
    )
  }
}

export class TransferInvitesHappyCaseFixture extends BaseMembershipFixture {
  private fromContext: MemberContext
  private toContext: MemberContext
  private invitesToTransfer: number

  private fromMemberInitialInvites?: number
  private toMemberInitialInvites?: number
  private event?: EventDetails
  private tx?: SubmittableExtrinsic<'promise'>

  public constructor(
    api: Api,
    query: QueryNodeApi,
    fromContext: MemberContext,
    toContext: MemberContext,
    invitesToTransfer = 2
  ) {
    super(api, query)
    this.fromContext = fromContext
    this.toContext = toContext
    this.invitesToTransfer = invitesToTransfer
  }

  private assertQueryNodeEventIsValid(
    eventDetails: EventDetails,
    txHash: string,
    qEvent: InvitesTransferredEventFieldsFragment | null
  ) {
    if (!qEvent) {
      throw new Error('Query node: InvitesTransferredEvent not found!')
    }
    const {
      event: { inExtrinsic, type },
      sourceMember,
      targetMember,
      numberOfInvites,
    } = qEvent
    assert.equal(inExtrinsic, txHash)
    assert.equal(type, EventType.InvitesTransferred)
    assert.equal(sourceMember.id, this.fromContext.memberId.toString())
    assert.equal(targetMember.id, this.toContext.memberId.toString())
    assert.equal(numberOfInvites, this.invitesToTransfer)
  }

  async execute(): Promise<void> {
    const { fromContext, toContext, invitesToTransfer } = this
    this.tx = this.api.tx.members.transferInvites(fromContext.memberId, toContext.memberId, invitesToTransfer)
    const txFee = await this.api.estimateTxFee(this.tx, fromContext.account)
    await this.api.treasuryTransferBalance(fromContext.account, txFee)

    const [fromMember, toMember] = await this.api.query.members.membershipById.multi<Membership>([
      fromContext.memberId,
      toContext.memberId,
    ])

    this.fromMemberInitialInvites = fromMember.invites.toNumber()
    this.toMemberInitialInvites = toMember.invites.toNumber()

    // Send transfer invites extrinsic
    const txRes = await this.api.signAndSend(this.tx, fromContext.account)
    this.event = await this.api.retrieveMembershipEventDetails(txRes, 'InvitesTransferred')
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    const { fromContext, toContext, invitesToTransfer } = this
    // Check "from" member
    await this.query.tryQueryWithTimeout(
      () => this.query.getMemberById(fromContext.memberId),
      (qSourceMember) => {
        if (!qSourceMember) {
          throw new Error('Query node: Source member not found')
        }
        assert.equal(qSourceMember.inviteCount, this.fromMemberInitialInvites! - invitesToTransfer)
      }
    )

    // Check "to" member
    const qTargetMember = await this.query.getMemberById(toContext.memberId)
    if (!qTargetMember) {
      throw new Error('Query node: Target member not found')
    }
    assert.equal(qTargetMember.inviteCount, this.toMemberInitialInvites! + invitesToTransfer)

    // Check event
    const qEvent = await this.query.getInvitesTransferredEvent(fromContext.memberId)

    this.assertQueryNodeEventIsValid(this.event!, this.tx!.hash.toString(), qEvent)
  }
}

export class AddStakingAccountsHappyCaseFixture extends BaseMembershipFixture {
  private memberContext: MemberContext
  private accounts: string[]

  private addExtrinsics: SubmittableExtrinsic<'promise'>[] = []
  private confirmExtrinsics: SubmittableExtrinsic<'promise'>[] = []
  private addEvents: EventDetails[] = []
  private confirmEvents: EventDetails[] = []

  public constructor(api: Api, query: QueryNodeApi, memberContext: MemberContext, accounts: string[]) {
    super(api, query)
    this.memberContext = memberContext
    this.accounts = accounts
  }

  private assertQueryNodeAddAccountEventIsValid(
    eventDetails: EventDetails,
    account: string,
    txHash: string,
    qEvents: StakingAccountAddedEventFieldsFragment[]
  ) {
    const qEvent = this.findMatchingQueryNodeEvent(eventDetails, qEvents)
    assert.equal(qEvent.event.inExtrinsic, txHash)
    assert.equal(qEvent.event.type, EventType.StakingAccountAddedEvent)
    assert.equal(qEvent.member.id, this.memberContext.memberId.toString())
    assert.equal(qEvent.account, account)
  }

  private assertQueryNodeConfirmAccountEventIsValid(
    eventDetails: EventDetails,
    account: string,
    txHash: string,
    qEvents: StakingAccountConfirmedEventFieldsFragment[]
  ) {
    const qEvent = this.findMatchingQueryNodeEvent(eventDetails, qEvents)
    assert.equal(qEvent.event.inExtrinsic, txHash)
    assert.equal(qEvent.event.type, EventType.StakingAccountConfirmed)
    assert.equal(qEvent.member.id, this.memberContext.memberId.toString())
    assert.equal(qEvent.account, account)
  }

  async execute(): Promise<void> {
    const { memberContext, accounts } = this
    this.addExtrinsics = accounts.map(() => this.api.tx.members.addStakingAccountCandidate(memberContext.memberId))
    this.confirmExtrinsics = accounts.map((a) => this.api.tx.members.confirmStakingAccount(memberContext.memberId, a))
    const addStakingCandidateFee = await this.api.estimateTxFee(this.addExtrinsics[0], accounts[0])
    const confirmStakingAccountFee = await this.api.estimateTxFee(this.confirmExtrinsics[0], memberContext.account)

    await this.api.treasuryTransferBalance(memberContext.account, confirmStakingAccountFee.muln(accounts.length))
    const stakingAccountRequiredBalance = addStakingCandidateFee.addn(MINIMUM_STAKING_ACCOUNT_BALANCE)
    await Promise.all(accounts.map((a) => this.api.treasuryTransferBalance(a, stakingAccountRequiredBalance)))
    // Add staking account candidates
    const addResults = await Promise.all(accounts.map((a, i) => this.api.signAndSend(this.addExtrinsics[i], a)))
    this.addEvents = await Promise.all(
      addResults.map((r) => this.api.retrieveMembershipEventDetails(r, 'StakingAccountAdded'))
    )
    // Confirm staking accounts
    const confirmResults = await Promise.all(
      this.confirmExtrinsics.map((tx) => this.api.signAndSend(tx, memberContext.account))
    )
    this.confirmEvents = await Promise.all(
      confirmResults.map((r) => this.api.retrieveMembershipEventDetails(r, 'StakingAccountConfirmed'))
    )
  }

  async runQueryNodeChecks() {
    await super.runQueryNodeChecks()
    const { memberContext, accounts, addEvents, confirmEvents, addExtrinsics, confirmExtrinsics } = this
    await this.query.tryQueryWithTimeout(
      () => this.query.getMemberById(memberContext.memberId),
      (qMember) => {
        if (!qMember) {
          throw new Error('Query node: Member not found')
        }
        assert.isNotEmpty(qMember.boundAccounts)
        assert.includeMembers(qMember.boundAccounts, accounts)
      }
    )

    // Check events
    const qAddedEvents = await this.query.getStakingAccountAddedEvents(memberContext.memberId)
    const qConfirmedEvents = await this.query.getStakingAccountConfirmedEvents(memberContext.memberId)
    accounts.forEach(async (account, i) => {
      this.assertQueryNodeAddAccountEventIsValid(addEvents[i], account, addExtrinsics[i].hash.toString(), qAddedEvents)
      this.assertQueryNodeConfirmAccountEventIsValid(
        confirmEvents[i],
        account,
        confirmExtrinsics[i].hash.toString(),
        qConfirmedEvents
      )
    })
  }
}

export class RemoveStakingAccountsHappyCaseFixture extends BaseMembershipFixture {
  private memberContext: MemberContext
  private accounts: string[]

  private events: EventDetails[] = []
  private extrinsics: SubmittableExtrinsic<'promise'>[] = []

  public constructor(api: Api, query: QueryNodeApi, memberContext: MemberContext, accounts: string[]) {
    super(api, query)
    this.memberContext = memberContext
    this.accounts = accounts
  }

  private assertQueryNodeRemoveAccountEventIsValid(
    eventDetails: EventDetails,
    account: string,
    txHash: string,
    qEvents: StakingAccountRemovedEventFieldsFragment[]
  ) {
    const qEvent = this.findMatchingQueryNodeEvent(eventDetails, qEvents)
    assert.equal(qEvent.event.inExtrinsic, txHash)
    assert.equal(qEvent.event.type, EventType.StakingAccountRemoved)
    assert.equal(qEvent.member.id, this.memberContext.memberId.toString())
    assert.equal(qEvent.account, account)
  }

  async execute(): Promise<void> {
    const { memberContext, accounts } = this
    this.extrinsics = accounts.map(() => this.api.tx.members.removeStakingAccount(memberContext.memberId))

    const removeStakingAccountFee = await this.api.estimateTxFee(this.extrinsics[0], accounts[0])

    await Promise.all(accounts.map((a) => this.api.treasuryTransferBalance(a, removeStakingAccountFee)))
    // Remove staking accounts
    const results = await Promise.all(accounts.map((a, i) => this.api.signAndSend(this.extrinsics[i], a)))
    this.events = await Promise.all(
      results.map((r) => this.api.retrieveMembershipEventDetails(r, 'StakingAccountRemoved'))
    )
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    const { memberContext, accounts, events, extrinsics } = this
    // Check member
    await this.query.tryQueryWithTimeout(
      () => this.query.getMemberById(memberContext.memberId),
      (qMember) => {
        if (!qMember) {
          throw new Error('Query node: Membership not found!')
        }
        accounts.forEach((a) => assert.notInclude(qMember.boundAccounts, a))
      }
    )

    // Check events
    const qEvents = await this.query.getStakingAccountRemovedEvents(memberContext.memberId)
    await Promise.all(
      accounts.map(async (account, i) => {
        this.assertQueryNodeRemoveAccountEventIsValid(events[i], account, extrinsics[i].hash.toString(), qEvents)
      })
    )
  }
}

type MembershipSystemValues = {
  referralCut: number
  defaultInviteCount: number
  membershipPrice: BN
  invitedInitialBalance: BN
}

export class SudoUpdateMembershipSystem extends BaseMembershipFixture {
  private newValues: Partial<MembershipSystemValues>

  private events: EventDetails[] = []
  private eventNames: MembershipEventName[] = []
  private extrinsics: SubmittableExtrinsic<'promise'>[] = []

  public constructor(api: Api, query: QueryNodeApi, newValues: Partial<MembershipSystemValues>) {
    super(api, query)
    this.newValues = newValues
  }

  private async getMembershipSystemValuesAt(blockNumber: number): Promise<MembershipSystemValues> {
    const blockHash = await this.api.getBlockHash(blockNumber)
    return {
      referralCut: (await this.api.query.members.referralCut.at(blockHash)).toNumber(),
      defaultInviteCount: (await this.api.query.members.initialInvitationCount.at(blockHash)).toNumber(),
      invitedInitialBalance: await this.api.query.members.initialInvitationBalance.at(blockHash),
      membershipPrice: await this.api.query.members.membershipPrice.at(blockHash),
    }
  }

  private async assertBeforeSnapshotIsValid(beforeSnapshot: MembershipSystemSnapshotFieldsFragment) {
    assert.isNumber(beforeSnapshot.snapshotBlock.number)
    const chainValues = await this.getMembershipSystemValuesAt(beforeSnapshot.snapshotBlock.number)
    assert.equal(beforeSnapshot.referralCut, chainValues.referralCut)
    assert.equal(beforeSnapshot.invitedInitialBalance, chainValues.invitedInitialBalance.toString())
    assert.equal(beforeSnapshot.membershipPrice, chainValues.membershipPrice.toString())
    assert.equal(beforeSnapshot.defaultInviteCount, chainValues.defaultInviteCount)
  }

  private assertAfterSnapshotIsValid(
    beforeSnapshot: MembershipSystemSnapshotFieldsFragment,
    afterSnapshot: MembershipSystemSnapshotFieldsFragment
  ) {
    const { newValues } = this
    const expectedValue = (field: keyof MembershipSystemValues) => {
      const newValue = newValues[field]
      return newValue === undefined ? beforeSnapshot[field] : newValue instanceof BN ? newValue.toString() : newValue
    }
    assert.equal(afterSnapshot.referralCut, expectedValue('referralCut'))
    assert.equal(afterSnapshot.invitedInitialBalance, expectedValue('invitedInitialBalance'))
    assert.equal(afterSnapshot.membershipPrice, expectedValue('membershipPrice'))
    assert.equal(afterSnapshot.defaultInviteCount, expectedValue('defaultInviteCount'))
  }

  private checkEvent<T extends AnyQueryNodeEvent>(qEvent: T | null, txHash: string): T {
    if (!qEvent) {
      throw new Error('Missing query-node event')
    }
    assert.equal(qEvent.event.inExtrinsic, txHash)
    return qEvent
  }

  async execute(): Promise<void> {
    if (this.newValues.referralCut !== undefined) {
      this.extrinsics.push(this.api.tx.sudo.sudo(this.api.tx.members.setReferralCut(this.newValues.referralCut)))
      this.eventNames.push('ReferralCutUpdated')
    }
    if (this.newValues.defaultInviteCount !== undefined) {
      this.extrinsics.push(
        this.api.tx.sudo.sudo(this.api.tx.members.setInitialInvitationCount(this.newValues.defaultInviteCount))
      )
      this.eventNames.push('InitialInvitationCountUpdated')
    }
    if (this.newValues.membershipPrice !== undefined) {
      this.extrinsics.push(
        this.api.tx.sudo.sudo(this.api.tx.members.setMembershipPrice(this.newValues.membershipPrice))
      )
      this.eventNames.push('MembershipPriceUpdated')
    }
    if (this.newValues.invitedInitialBalance !== undefined) {
      this.extrinsics.push(
        this.api.tx.sudo.sudo(this.api.tx.members.setInitialInvitationBalance(this.newValues.invitedInitialBalance))
      )
      this.eventNames.push('InitialInvitationBalanceUpdated')
    }

    // We don't use api.makeSudoCall, since we cannot(?) then access tx hashes
    const sudo = await this.api.query.sudo.key()
    const results = await Promise.all(this.extrinsics.map((tx) => this.api.signAndSend(tx, sudo)))
    this.events = await Promise.all(
      results.map((r, i) => this.api.retrieveMembershipEventDetails(r, this.eventNames[i]))
    )
  }

  async runQueryNodeChecks(): Promise<void> {
    await super.runQueryNodeChecks()
    const { events, extrinsics, eventNames } = this
    const afterSnapshotBlockTimestamp = Math.max(...events.map((e) => e.blockTimestamp))

    // Fetch "afterSnapshot" first to make sure query node has progressed enough
    const afterSnapshot = (await this.query.tryQueryWithTimeout(
      () => this.query.getMembershipSystemSnapshotAt(afterSnapshotBlockTimestamp),
      (snapshot) => assert.isOk(snapshot)
    )) as MembershipSystemSnapshotFieldsFragment

    const beforeSnapshot = await this.query.getMembershipSystemSnapshotBefore(afterSnapshotBlockTimestamp)

    if (!beforeSnapshot) {
      throw new Error(`Query node: MembershipSystemSnapshot before timestamp ${afterSnapshotBlockTimestamp} not found!`)
    }

    // Validate snapshots
    await this.assertBeforeSnapshotIsValid(beforeSnapshot)
    this.assertAfterSnapshotIsValid(beforeSnapshot, afterSnapshot)

    // Check events
    await Promise.all(
      events.map(async (event, i) => {
        const tx = extrinsics[i]
        const eventName = eventNames[i]
        const txHash = tx.hash.toString()
        const { blockNumber, indexInBlock } = event
        if (eventName === 'ReferralCutUpdated') {
          const { newValue } = this.checkEvent(
            await this.query.getReferralCutUpdatedEvent(blockNumber, indexInBlock),
            txHash
          )
          assert.equal(newValue, this.newValues.referralCut)
        }
        if (eventName === 'MembershipPriceUpdated') {
          const { newPrice } = this.checkEvent(
            await this.query.getMembershipPriceUpdatedEvent(blockNumber, indexInBlock),
            txHash
          )
          assert.equal(newPrice, this.newValues.membershipPrice!.toString())
        }
        if (eventName === 'InitialInvitationBalanceUpdated') {
          const { newInitialBalance } = this.checkEvent(
            await this.query.getInitialInvitationBalanceUpdatedEvent(blockNumber, indexInBlock),
            txHash
          )
          assert.equal(newInitialBalance, this.newValues.invitedInitialBalance!.toString())
        }
        if (eventName === 'InitialInvitationCountUpdated') {
          const { newInitialInvitationCount } = this.checkEvent(
            await this.query.getInitialInvitationCountUpdatedEvent(blockNumber, indexInBlock),
            txHash
          )
          assert.equal(newInitialInvitationCount, this.newValues.defaultInviteCount)
        }
      })
    )
  }
}
