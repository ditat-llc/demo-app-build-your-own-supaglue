import {
  db,
  dbUpsert,
  ensureSchema,
  getCommonObjectTable,
  schema,
} from '@supaglue/db'
import {initBYOSupaglueSDK} from '@supaglue/sdk'
import {and, eq, sql} from 'drizzle-orm'
import type {SendEventPayload} from 'inngest/helpers/types'
import {initSupaglueSDK} from '@opensdks/sdk-supaglue'
import {HTTPError, parseErrorInfo} from '../vdk/errors'
import {env} from './env'
import type {Events} from './events'

/**
 * Unlike functions, routines are designed to run without dependency on Inngest
 * So they can be used with any job queue system, such as BullMQ or home grown system built
 * on top of postgres / redis / pubsub / whatever.
 */
export type RoutineInput<T extends keyof Events> = {
  event: {data: Events[T]['data']; id?: string}
  step: {
    run: <T>(name: string, fn: () => Promise<T>) => Promise<T> | T
    sendEvent: (
      stepId: string,
      events: SendEventPayload<Events>,
    ) => Promise<unknown> // SendEventOutput
  }
}
type SingleNoArray<T> = T extends Array<infer U> ? U : T
export type EventPayload = SingleNoArray<SendEventPayload<Events>>

// export async function nangoScheduleSyncs({step}: RoutineInput<never>) {
//  const nango = initNangoSDK({
//   headers: {authorization: `Bearer ${env.NANGO_SECRET_KEY}`},
// })

//   const {
//     data: {connections},
//   } = await nango.GET('/connection')
//   // console.log(connections)

//   await step.sendEvent(
//     'emit-connection-sync-events',
//     connections
//       .filter((c) => c.provider === 'outreach')
//       .map((c) => ({
//         name: 'connection/sync',
//         // c.provider is the providerConfigKey, very confusing of nango
//         data: {connection_id: c.connection_id, provider_config_key: c.provider},
//       })),
//   )
// }

export async function scheduleSyncs({step}: RoutineInput<never>) {
  const supaglue = initSupaglueSDK({
    headers: {'x-api-key': env.SUPAGLUE_API_KEY!},
  })

  const [syncConfigs, customers] = await Promise.all([
    supaglue.mgmt.GET('/sync_configs').then((r) => r.data),
    supaglue.mgmt.GET('/customers').then((r) => r.data),
  ])
  const connections = await Promise.all(
    customers
      // .slice(0, 10) // TODO: comment me out in production
      .map((c) =>
        supaglue.mgmt
          .GET('/customers/{customer_id}/connections', {
            params: {path: {customer_id: c.customer_id}},
          })
          .then((r) => r.data),
      ),
  ).then((nestedArr) => nestedArr.flat())

  await step.sendEvent(
    'emit-connection-sync-events',
    connections
      .map((c) => {
        if (c.category !== 'crm' && c.category !== 'engagement') {
          return null
        }
        const syncConfig = syncConfigs.find(
          (sc) => sc.provider_name === c.provider_name,
        )?.config
        return {
          name: 'connection/sync',
          data: {
            customer_id: c.customer_id,
            provider_name: c.provider_name,
            vertical: c.category,
            common_objects: syncConfig?.common_objects?.map((o) => o.object),
            standard_objects: syncConfig?.standard_objects?.map(
              (o) => o.object,
            ),
          },
        } satisfies EventPayload
      })
      .filter((c): c is NonNullable<typeof c> => !!c),
  )
}

const sqlNow = sql`now()`

export async function syncConnection({
  event, // step,
}: RoutineInput<'connection/sync'>) {
  const {
    data: {
      customer_id,
      provider_name,
      vertical,
      common_objects = [],
      sync_mode = 'incremental',
      destination_schema,
    },
  } = event
  console.log('[syncConnection] Start', {
    customer_id,
    provider_name,
    eventId: event.id,
    sync_mode,
    vertical,
    common_objects,
  })

  // This can probably be done via an upsert returning...
  const syncState = await db.query.sync_state
    .findFirst({
      where: and(
        eq(schema.sync_state.customer_id, customer_id),
        eq(schema.sync_state.provider_name, provider_name),
      ),
    })
    .then(
      (ss) =>
        ss ??
        db
          .insert(schema.sync_state)
          .values({
            customer_id,
            provider_name,
            state: sql`${{}}::jsonb`,
          })
          .returning()
          .then((rows) => rows[0]!),
    )

  const syncRunId = await db
    .insert(schema.sync_run)
    .values({
      input_event: sql`${event}::jsonb`,
      initial_state: sql`${syncState.state}::jsonb`,
      started_at: sqlNow,
    })
    .returning()
    .then((rows) => rows[0]!.id)

  const byos = initBYOSupaglueSDK({
    headers: {
      'x-api-key': env.SUPAGLUE_API_KEY,
      'x-customer-id': customer_id, // This relies on customer-id mapping 1:1 to connection_id
      'x-provider-name': provider_name, // This relies on provider_config_key mapping 1:1 to provider-name
    },
  })

  const overallState = (syncState.state ?? {}) as Record<
    string,
    {cursor?: string | null}
  >

  let errorInfo: ReturnType<typeof parseErrorInfo> | undefined

  const metrics: Record<string, number | string> = {}

  function incrementMetric(name: string, amount = 1) {
    const metric = metrics[name]
    metrics[name] = (typeof metric === 'number' ? metric : 0) + amount
    return metrics[name] as number
  }
  function setMetric<T extends string | number>(name: string, value: T) {
    metrics[name] = value
    return metrics[name] as T
  }

  async function syncStreamPage(
    stream: string,
    table: ReturnType<typeof getCommonObjectTable>,
    state: {cursor?: string | null},
  ) {
    try {
      const res = await byos.GET(
        `/${vertical}/v2/${stream}` as '/crm/v2/contact',
        {params: {query: {cursor: state.cursor}}}, // We let each provider determine the page size rather than hard-coding
      )
      const count = incrementMetric(`${stream}_count`, res.data.items.length)
      incrementMetric(`${stream}_page_count`)
      console.log(`Syncing ${vertical} ${stream} count=${count}`)
      if (res.data.items.length) {
        await dbUpsert(
          db,
          table,
          res.data.items.map(({raw_data, ...item}) => ({
            // Primary keys
            _supaglue_application_id: env.SUPAGLUE_APPLICATION_ID,
            _supaglue_customer_id: customer_id, //  '$YOUR_CUSTOMER_ID',
            _supaglue_provider_name: provider_name,
            id: item.id,
            // Other columns
            created_at: sqlNow,
            updated_at: sqlNow,
            _supaglue_emitted_at: sqlNow,
            last_modified_at: sqlNow, // TODO: Fix me...
            is_deleted: false,
            // Workaround jsonb support issue... https://github.com/drizzle-team/drizzle-orm/issues/724
            raw_data: sql`${raw_data ?? ''}::jsonb`,
            _supaglue_unified_data: sql`${item}::jsonb`,
          })),
          {
            insertOnlyColumns: ['created_at'],
            noDiffColumns: [
              '_supaglue_emitted_at',
              'last_modified_at',
              'updated_at',
            ],
          },
        )
      }
      return {
        next_cursor: res.data.next_cursor,
        has_next_page: res.data.has_next_page,
      }
    } catch (err) {
      // HTTP 501 not implemented
      if (err instanceof HTTPError && err.code === 501) {
        console.warn(
          `[sync progress] ${provider_name} does not implement ${stream}`,
        )
        return {has_next_page: false, next_cursor: null}
      }
      throw err
    }
  }

  async function syncStream(stream: string) {
    const fullEntity = `${vertical}_${stream}`
    console.log('[syncConnection] Syncing', fullEntity)
    const table = getCommonObjectTable(fullEntity, {
      schema: destination_schema,
    })
    await db.execute(table.createIfNotExistsSql())
    const state = sync_mode === 'full' ? {} : overallState[stream] ?? {}
    overallState[stream] = state
    const streamSyncMode = state.cursor ? 'incremental' : 'full'
    setMetric(`${stream}_sync_mode`, streamSyncMode)

    while (true) {
      // const ret = await step.run(
      //   `${stream}-sync-${state.cursor ?? ''}`,
      //   iteratePage,
      // )
      const ret = await syncStreamPage(stream, table, state)
      console.log('[sync progress]', {
        stream,
        completed_cursor: state.cursor,
        ...ret,
      })
      state.cursor = ret.next_cursor
      // Persist state. TODO: Figure out how to make this work with step function
      await Promise.all([
        dbUpsert(
          db,
          schema.sync_state,
          [
            {
              ...syncState,
              state: sql`${overallState}::jsonb`,
              updated_at: sqlNow,
            },
          ],
          {
            shallowMergeJsonbColumns: ['state'], // For race condition / concurrent sync of multiple streams
            noDiffColumns: ['created_at', 'updated_at'],
          },
        ),
        // Should this happen in a transaction? doesn't seem necessary but still
        db
          .update(schema.sync_run)
          .set({
            // Should we call it currentState instead? Also do we need it on the sync_state itself?
            final_state: sql`${overallState}::jsonb`,
            metrics: sql`${metrics}::jsonb`,
          })
          .where(eq(schema.sync_run.id, syncRunId)),
      ])
      if (!ret.has_next_page) {
        break
      }
    }
  }

  try {
    // Load this from a config please...
    if (destination_schema) {
      await ensureSchema(db, destination_schema)
      console.log('[syncConnection] Ensured schema', destination_schema)
    }
    // TODO: Collect list of errors not just the last one...
    for (const stream of common_objects) {
      try {
        await syncStream(stream)
      } catch (err) {
        console.error('[syncConnection] Error syncing', stream, err)
        errorInfo = parseErrorInfo(err)
        // No longer authenticated error means we should be able to break out of all other streams, it's unnecessary.
        // Will need to think more about how this works for parallel read scenarios though.
        if (errorInfo?.error_type === 'USER_ERROR') {
          break
        }
      }
    }
  } catch (err) {
    errorInfo = parseErrorInfo(err)
  } finally {
    await db
      .update(schema.sync_run)
      .set({
        ...errorInfo,
        completed_at: sqlNow,
        final_state: sql`${overallState}::jsonb`,
        metrics: sql`${metrics}::jsonb`,
      })
      .where(eq(schema.sync_run.id, syncRunId))
  }

  const status = errorInfo?.error_type ?? 'SUCCESS'
  console.log(`[syncConnection] Complete ${status}`, {
    customer_id,
    provider_name,
    status,
    event_id: event.id,
    metrics,
    error: errorInfo,
    final_state: overallState,
  })
}

// Later...
// Need to figure out if stepFunction behaves as expected...
