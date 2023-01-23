import { DatabaseManager, SubstrateEvent } from '@joystream/hydra-common'
import { ICreateApp, IUpdateApp } from '@joystream/metadata-protobuf'
import { integrateMeta } from '@joystream/metadata-protobuf/utils'
import { ChannelId } from '@joystream/types/primitives'
import { logger } from '@joystream/warthog'
import { Channel, App } from 'query-node/dist/model'
import { inconsistentState } from '../common'

export async function processCreateAppMessage(
  store: DatabaseManager,
  event: SubstrateEvent,
  channelId: ChannelId,
  message: ICreateApp
): Promise<void> {
  const { name, appMetadata } = message
  const appId = await createAppId(event)

  const isAppExists = await store.get(App, {
    where: {
      name: name,
    },
  })

  if (isAppExists) {
    inconsistentState(`App with this name already exists:`, name)
  }

  // load channel
  const channel = await store.get(Channel, {
    where: { id: channelId.toString() },
  })

  // ensure channel exists
  if (!channel) {
    return inconsistentState('Non-existing channel update requested', channelId)
  }

  const newApp = new App({
    name,
    id: appId,
    websiteUrl: appMetadata?.websiteUrl || undefined,
    useUri: appMetadata?.useUri || undefined,
    smallIcon: appMetadata?.smallIcon || undefined,
    mediumIcon: appMetadata?.mediumIcon || undefined,
    bigIcon: appMetadata?.bigIcon || undefined,
    oneLiner: appMetadata?.oneLiner || undefined,
    description: appMetadata?.description || undefined,
    termsOfService: appMetadata?.termsOfService || undefined,
    platforms: appMetadata?.platforms || undefined,
    category: appMetadata?.category || undefined,
    authKey: appMetadata?.authKey || undefined,
    ownerCuratorGroup: channel.ownerCuratorGroup,
    ownerMember: channel.ownerMember,
    channel,
  })
  await store.save<App>(newApp)
  logger.info('App has been created', { name })
}

async function createAppId(event: SubstrateEvent): Promise<string> {
  return `${event.blockNumber}-${event.indexInBlock}`
}

export async function processUpdateApp(
  store: DatabaseManager,
  channelId: ChannelId,
  message: IUpdateApp
): Promise<void> {
  const { appId, appMetadata } = message

  const app = await getAppById(store, appId)

  if (!app) {
    inconsistentState("App doesn't exists; appId:", appId)
  }
  if (app?.channel.id !== channelId.toString()) {
    inconsistentState(`Cannot update app; app does not belong to the channelId: `, channelId)
  }

  if (appMetadata) {
    integrateMeta(app, appMetadata, [
      'websiteUrl',
      'useUri',
      'smallIcon',
      'mediumIcon',
      'bigIcon',
      'oneLiner',
      'description',
      'termsOfService',
      'platforms',
      'category',
      'authKey',
    ])
  }

  await store.save<App>(app)
  logger.info('App has been updated', { appId })
}

export async function getAppById(store: DatabaseManager, appId: string): Promise<App | undefined> {
  const app = await store.get(App, {
    where: {
      id: appId,
    },
    relations: ['channel'],
  })
  return app
}
