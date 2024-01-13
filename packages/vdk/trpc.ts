import type {OpenApiMeta} from '@lilyrose2798/trpc-openapi'
import {initTRPC, TRPCError} from '@trpc/server'
import {nangoProxyLink} from './nangoProxyLink'
import type {Provider} from './provider'

export type RouterContext = {
  nangoSecretKey: string
  headers: Headers
  providerByName: Record<string, Provider>
}

export interface RouterMeta extends OpenApiMeta {}

// Technically trpc doesn't quite belong in here... However it adds complexity to do dependency injection
// into each vertical so we are keeping it super simple for now...
export const trpc = initTRPC
  .context<RouterContext>()
  .meta<RouterMeta>()
  .create({allowOutsideOfServer: true})

export const publicProcedure = trpc.procedure

export const remoteProcedure = publicProcedure.use(
  async ({next, ctx, path}) => {
    const connectionId = ctx.headers.get('x-connection-id')
    if (!connectionId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'x-connection-id header is required',
      })
    }
    const providerName = ctx.headers.get('x-provider-name')
    if (!providerName) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'x-provider-name header is required',
      })
    }

    const provider = ctx.providerByName[providerName]
    if (!provider) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Provider ${providerName} not found`,
      })
    }

    const nangoLink = nangoProxyLink({
      secretKey: ctx.nangoSecretKey,
      connectionId,
      providerConfigKey:
        ctx.headers.get('x-provider-config-key') ?? providerName,
    })

    return next({
      ctx: {...ctx, path, connectionId, providerName, provider, nangoLink},
    })
  },
)

export type RemoteProcedureContext = ReturnType<
  (typeof remoteProcedure)['query']
>['_def']['_ctx_out']
