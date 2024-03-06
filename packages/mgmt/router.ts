import type {_Provider, ProviderFromRouter} from '@supaglue/vdk'
import {NotImplementedError, publicProcedure, trpc, z} from '@supaglue/vdk'
import {nangoPostgresProvider} from './providers/nango-postgres-provider'
import {supaglueProvider} from './providers/supaglue-provider'
import * as unified from './unifiedModels'

export {unified}

export const mgmtProcedure = publicProcedure.use(async ({next, ctx}) => {
  const provider: _Provider<InitOpts> =
    ctx.mgmtProviderName === 'nango' ? nangoPostgresProvider : supaglueProvider
  const providerName =
    ctx.mgmtProviderName === 'nango' ? 'nango-postgres' : 'supaglue'

  return next({ctx: {...ctx, provider, providerName}})
})

type MgmtProcedureContext = ReturnType<
  (typeof mgmtProcedure)['query']
>['_def']['_ctx_out']

type InitOpts = {ctx: MgmtProcedureContext}

export type MgmtProvider<TInstance> = ProviderFromRouter<
  typeof mgmtRouter,
  TInstance,
  MgmtProcedureContext,
  InitOpts
>

// Should the mgmt router be refactored into its own package outside of API?
export const mgmtRouter = trpc.router({
  // Customer management
  listCustomers: mgmtProcedure
    .meta({openapi: {method: 'GET', path: '/customers'}})
    .input(z.void())
    .output(z.array(unified.customer))
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  getCustomer: mgmtProcedure
    .meta({openapi: {method: 'GET', path: '/customers/{id}'}})
    .input(z.object({id: z.string()}))
    .output(unified.customer)
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),
  upsertCustomer: mgmtProcedure
    .meta({openapi: {method: 'PUT', path: '/customers/{customer_id}'}})
    .input(unified.customer.pick({customer_id: true, name: true, email: true}))
    .output(unified.customer)
    .mutation(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  // Connection management

  listConnections: mgmtProcedure
    .meta({
      openapi: {method: 'GET', path: '/customers/{customer_id}/connections'},
    })
    .input(z.object({customer_id: z.string()}))
    .output(z.array(unified.connection))
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  getConnection: mgmtProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/customers/{customer_id}/connections/{provider_name}',
      },
    })
    .input(z.object({customer_id: z.string(), provider_name: z.string()}))
    .output(unified.connection)
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),
  deleteConnection: mgmtProcedure
    .meta({
      openapi: {
        method: 'DELETE',
        path: '/customers/{customer_id}/connections/{provider_name}',
      },
    })
    .input(z.object({customer_id: z.string(), provider_name: z.string()}))
    .output(z.void())
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  // MARK: - Sync config management

  listSyncConfigs: mgmtProcedure
    .meta({openapi: {method: 'GET', path: '/sync_configs'}})
    .input(z.void())
    .output(z.array(unified.sync_config))
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  getConnectionSyncConfig: mgmtProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/connection_sync_configs',
      },
    })
    .input(z.void())
    .output(unified.connection_sync_config)
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),

  upsertConnectionSyncConfig: mgmtProcedure
    .meta({
      openapi: {
        method: 'PUT',
        path: '/connection_sync_configs',
      },
    })
    .input(unified.connection_sync_config)
    .output(unified.connection_sync_config)
    .query(({ctx, input}) => mgmtProxyCallProvider({ctx, input})),
})

async function mgmtProxyCallProvider({
  input,
  ctx,
}: {
  input: unknown
  ctx: MgmtProcedureContext
}) {
  const instance = ctx.provider.__init__({ctx})
  // verticals.salesEngagement.listContacts -> listContacts
  const methodName = ctx.path.split('.').pop() ?? ''
  const implementation = ctx.provider?.[methodName as '__init__'] as Function

  if (typeof implementation !== 'function') {
    throw new NotImplementedError(
      `${ctx.providerName} provider does not implement ${ctx.path}`,
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const out = await implementation({instance, input, ctx})
  // console.log('[proxyCallRemote] output', out)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return out
}
