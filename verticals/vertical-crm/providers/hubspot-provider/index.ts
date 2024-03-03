import type {BaseRecord, z} from '@supaglue/vdk'
import {
  BadRequestError,
  InternalServerError,
  LastUpdatedAtNextOffset,
  NotFoundError,
  uniqBy,
} from '@supaglue/vdk'
import {LRUCache} from 'lru-cache'
import * as RM from 'remeda'
import type {Oas_crm_schemas} from '@opensdks/sdk-hubspot'
import {initHubspotSDK, type HubspotSDK} from '@opensdks/sdk-hubspot'
import type {CRMProvider} from '../../router'
import type {HSDeal} from './mappers'
import {HUBSPOT_STANDARD_OBJECTS, mappers, propertiesToFetch} from './mappers'

const isStandardObjectType = (
  objectType: string,
): objectType is (typeof HUBSPOT_STANDARD_OBJECTS)[number] =>
  HUBSPOT_STANDARD_OBJECTS.includes(
    objectType as (typeof HUBSPOT_STANDARD_OBJECTS)[number],
  )

/**
 * In certain cases, Hubspot cannot determine the object type based on just the name for custom objects,
 * so we need to get the ID.
 */
async function getObjectTypeFromNameOrId(
  instance: HubspotSDK,
  nameOrId: string,
): Promise<string> {
  // Standard objects can be referred by name no problem
  if (isStandardObjectType(nameOrId)) {
    return nameOrId
  }
  // isAlreadyObjectTypeId

  if (/^\d+-\d+$/.test(nameOrId)) {
    return nameOrId
  }
  const schemas = await instance.crm_schemas
    .GET('/crm/v3/schemas')
    .then((r) => r.data.results)

  // const schemas = await this.#client.crm.schemas.coreApi.getAll();
  const schemaId = schemas.find(
    (schema) => schema.name === nameOrId || schema.objectTypeId === nameOrId,
  )?.objectTypeId
  if (!schemaId) {
    throw new NotFoundError(
      `Could not find custom object schema with name or id ${nameOrId}`,
    )
  }
  return schemaId
}

const _listObjectsIncrementalThenMap = async <TIn, TOut extends BaseRecord>(
  instance: HubspotSDK,
  {
    objectType,
    fields,
    ...opts
  }: {
    objectType: string
    fields: string[]
    /** Will use the properties endpoint to fetch all available fields */
    includeAllFields?: boolean
    associations?: string[]
    mapper: {parse: (rawData: unknown) => TOut; _in: TIn}
    page_size?: number
    cursor?: string | null
    // For caching prupose only really...
    ctx: {customerId: string}
  },
) => {
  const limit = opts?.page_size ?? 100
  const cursor = LastUpdatedAtNextOffset.fromCursor(opts?.cursor)
  const kUpdatedAt =
    objectType === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate'
  // We may want to consider using the list rather than search endpoint for this stuff...

  const res = await instance[`crm_${objectType as 'contacts'}`].POST(
    `/crm/v3/objects/${objectType as 'contacts'}/search`,
    {
      body: {
        properties: Array.from(
          new Set([
            'hs_object_id',
            'createdate',
            'lastmodifieddate',
            'hs_lastmodifieddate',
            'name',
            ...fields,
            ...(opts.includeAllFields
              ? await cachedGetObjectProperties(instance, {
                  customerId: opts.ctx.customerId,
                  objectType,
                })
              : []),
          ]),
        ),
        filterGroups: cursor?.last_updated_at
          ? [
              {
                filters: [
                  {
                    propertyName: kUpdatedAt,
                    operator: 'GTE',
                    value: cursor?.last_updated_at,
                  },
                ],
              },
            ]
          : [],
        after: cursor?.next_offset ?? '',
        sorts: [
          {
            propertyName: kUpdatedAt,
            direction: 'ASCENDING',
          },
          // Cannot sort by multiple values unfortunately...
          // {
          //   propertyName: 'hs_object_id',
          //   direction: 'ASCENDING',
          // },
        ] as unknown as string[],
        limit,
      },
    },
  )

  const batchedAssociations = await Promise.all(
    (opts.associations ?? []).map(async (associatedType) => {
      const toObjectIdsByFromObjectId = await _batchListAssociations(instance, {
        fromObjectIds: res.data.results.map((r) => r.id),
        fromObjectType: objectType,
        toObjectType: associatedType,
      })
      return [associatedType, toObjectIdsByFromObjectId] as const
    }),
  )
  // console.log('associations:', batchedAssociations)
  const pipelineStageMapping =
    objectType === 'deals'
      ? await cachedGetPipelineStageMapping(instance, opts.ctx)
      : undefined

  const resultsExtended = res.data.results.map((rawData) => {
    const currentAssociations = Object.fromEntries(
      batchedAssociations.map(([associatedType, toObjectIdsByFromObjectId]) => {
        const toIds = toObjectIdsByFromObjectId[rawData.id] ?? []
        return [associatedType, toIds]
      }),
    ) satisfies z.infer<typeof HSDeal>['#associations']
    // console.log('currentAssociations:', currentAssociations)

    return {
      ...rawData,
      '#associations': currentAssociations,
      '#pipelineStageMapping': pipelineStageMapping,
    }
  })

  const items = resultsExtended.map(opts.mapper.parse)
  const lastItem = items[items.length - 1]
  return {
    items,
    // Not the same as simply items.length === 0
    has_next_page: !!res.data.paging?.next?.after,
    next_cursor:
      (lastItem
        ? LastUpdatedAtNextOffset.toCursor({
            last_updated_at: lastItem.updated_at,
            next_offset:
              // offset / offset-like cursor is only usable if the filtering criteria doesn't change, notably the last_updated_at timestamp
              // in practice this means that we only care about `after` offset when we have more than `limit` number of items modified at the exact
              // same timestamp
              lastItem.updated_at === cursor?.last_updated_at
                ? res.data.paging?.next?.after
                : undefined,
          })
        : opts?.cursor) ?? null,
  }
}

// TODO: implement this when reading batch
export const _batchListAssociations = async (
  instance: HubspotSDK,
  opts: {
    fromObjectIds: string[]
    fromObjectType: string
    toObjectType: string
  },
): Promise<Record<string /*fromId*/, string[] /* toIds */>> => {
  if (!opts.fromObjectIds.length) {
    return {}
  }
  try {
    const associations = await instance.crm_associations.POST(
      '/{fromObjectType}/{toObjectType}/batch/read',
      {
        params: {
          path: {
            fromObjectType: opts.fromObjectType,
            toObjectType: opts.toObjectType,
          },
        },
        body: {inputs: opts.fromObjectIds.map((id) => ({id}))},
      },
    )
    return associations.data.results
      .map((result) => ({
        [result.from.id]: [...new Set(result.to.map(({id}) => id))],
      }))
      .reduce((acc, curr) => ({...acc, ...curr}), {})
  } catch (err) {
    console.log(err)
    throw err
  }
}

const objectPropertiesCache = new LRUCache<
  string /* {customerId}_{objectType} */,
  string[] /* {fieldName}[] */
>({
  ttl: 1000 * 60 * 5,
  ttlAutopurge: false,
  max: 100,
})

const cachedGetObjectProperties = async (
  instance: HubspotSDK,
  opts: {customerId: string; objectType: string},
) => {
  const cacheKey = `${opts.customerId}_${opts.objectType}`
  const cached = objectPropertiesCache.get(cacheKey)
  if (cached) {
    console.log(
      '[hubspot] Using cached available fields for objectType:',
      opts.objectType,
    )
    return cached
  }
  const fields = await instance.crm_properties
    .GET('/crm/v3/properties/{objectType}', {
      params: {path: {objectType: opts.objectType}},
    })
    .then((r) => r.data.results.map((obj) => obj.name))
  objectPropertiesCache.set(cacheKey, fields)
  return fields
}

const pipelineStageMappingCache = new LRUCache<
  string /* {customerId} */,
  PipelineStageMapping
>({
  ttl: 1000 * 60 * 5,
  ttlAutopurge: false,
  max: 100,
})

// TODO: Introduce a proper caching fetchLink based on customerId that can be backed by
// memory cache or redis cache... For now we are just gonna hack around by passing the customerId context around...
const cachedGetPipelineStageMapping = async (
  instance: HubspotSDK,
  opts: {customerId: string},
): ReturnType<typeof _getPipelineStageMapping> => {
  const cached = pipelineStageMappingCache.get(opts.customerId)
  if (cached) {
    console.log(
      '[hubspot] Using cached pipeline stage mapping for customerId:',
      opts.customerId,
    )
    return cached
  }
  const res = await _getPipelineStageMapping(instance)
  pipelineStageMappingCache.set(opts.customerId, res)
  return res
}

export type PipelineStageMapping = Awaited<
  ReturnType<typeof _getPipelineStageMapping>
>
const _getPipelineStageMapping = async (instance: HubspotSDK) => {
  const res = await instance.crm_pipelines.GET(
    '/crm/v3/pipelines/{objectType}',
    {params: {path: {objectType: 'deals'}}},
  )
  return RM.mapToObj(res.data.results, (result) => [
    result.id,
    {
      label: result.label,
      stageLabelById: RM.mapToObj(result.stages, (stage) => [
        stage.id,
        stage.label,
      ]),
    },
  ])
}

const _listObjectsFullThenMap = async <TIn, TOut extends BaseRecord>(
  instance: HubspotSDK,
  {
    objectType,
    ...opts
  }: {
    objectType: string
    mapper: {parse: (rawData: unknown) => TOut; _in: TIn}
    page_size?: number
    cursor?: string | null
  },
) => {
  const res = await instance[`crm_${objectType as 'owners'}`].GET(
    `/crm/v3/${objectType as 'owners'}/`,
    {
      params: {
        query: {
          after: opts?.cursor ?? undefined,
          limit: opts?.page_size ?? 100,
        },
      },
    },
  )
  return {
    items: res.data.results.map(opts.mapper.parse),
    has_next_page: !!res.data.paging?.next?.after,
    // This would reset the sync and loop back from the beginning, except
    // the has_next_page check prevents that
    next_cursor: res.data.paging?.next?.after,
  }
}

export const hubspotProvider = {
  __init__: ({proxyLinks}) =>
    initHubspotSDK({
      headers: {authorization: 'Bearer ...'}, // This will be populated by Nango, or you can populate your own...
      links: (defaultLinks) => [...proxyLinks, ...defaultLinks],
    }),
  listContacts: async ({instance, input, ctx}) =>
    _listObjectsIncrementalThenMap(instance, {
      ...input,
      objectType: 'contacts',
      mapper: mappers.contact,
      fields: propertiesToFetch.contact,
      includeAllFields: true,
      ctx,
    }),
  listAccounts: async ({instance, input, ctx}) =>
    _listObjectsIncrementalThenMap(instance, {
      ...input,
      objectType: 'companies',
      mapper: mappers.account,
      fields: propertiesToFetch.account,
      includeAllFields: true,
      ctx,
    }),
  listOpportunities: async ({instance, input, ctx}) =>
    _listObjectsIncrementalThenMap(instance, {
      ...input,
      objectType: 'deals',
      mapper: mappers.opportunity,
      fields: propertiesToFetch.deal,
      includeAllFields: true,
      associations: ['company'],
      ctx,
    }),
  // Original supaglue never implemented this, TODO: handle me...
  // listLeads: async ({instance, input, ctx}) =>
  //   _listObjectsFullThenMap(instance, {
  //     ...input,
  //     objectType: 'leads',
  //     mapper: mappers.lead,
  //     fields: [],
  //   }),
  // Owners does not have a search API... so we have to do a full sync every time
  listUsers: async ({instance, input}) =>
    _listObjectsFullThenMap(instance, {
      objectType: 'owners',
      mapper: mappers.user,
      page_size: input?.page_size,
      cursor: input?.cursor,
    }),

  // MARK: - Custom objects
  listCustomObjectRecords: async ({instance, input}) =>
    _listObjectsFullThenMap(instance, {
      objectType: await getObjectTypeFromNameOrId(instance, input.object_name),
      mapper: mappers.customObject,
      page_size: input?.page_size,
      cursor: input?.cursor,
    }),

  createCustomObjectRecord: async ({instance, input}) => {
    // This may cause a runtime error as Hubspot appears to only support string prop values
    // during creation anyways
    const properties = input.record as Record<string, string>
    const objectType = await getObjectTypeFromNameOrId(
      instance,
      input.object_name,
    )
    const res = await instance.crm_objects.POST(
      '/crm/v3/objects/{objectType}',
      {params: {path: {objectType}}, body: {properties, associations: []}},
    )
    return {record: res.data}
  },

  // MARK: - Metadata endpoints

  metadataListObjects: async ({instance, input}) =>
    uniqBy(
      [
        ...(!input.type || input.type === 'standard'
          ? HUBSPOT_STANDARD_OBJECTS.map((obj) => ({id: obj, name: obj}))
          : []),
        ...(!input.type || input.type === 'custom'
          ? await instance.crm_schemas
              .GET('/crm/v3/schemas')
              .then((res) =>
                res.data.results.map((obj) => ({id: obj.id, name: obj.name})),
              )
          : []),
      ],
      (o) => o.id,
    ),
  metadataListObjectProperties: async ({instance, input}) => {
    const res = await instance.crm_properties.GET(
      '/crm/v3/properties/{objectType}',
      {params: {path: {objectType: input.object_name}}},
    )
    return res.data.results.map((obj) => ({
      id: obj.name,
      label: obj.label,
      type: obj.type,
    }))
  },

  metadataCreateCustomObjectSchema: async ({instance, input: params}) => {
    const primaryField = params.fields.find(
      (field) => field.id === params.primary_field_id,
    )

    if (!primaryField) {
      throw new BadRequestError(
        `Could not find primary field with key name ${params.primary_field_id}`,
      )
    }

    if (primaryField.type !== 'text') {
      throw new BadRequestError(
        `Primary field must be of type text, but was ${primaryField.type} with key name ${params.primary_field_id}`,
      )
    }

    if (!primaryField.is_required) {
      throw new BadRequestError(
        `Primary field must be required, but was not with key name ${params.primary_field_id}`,
      )
    }

    const res = await instance.crm_schemas.POST('/crm/v3/schemas', {
      body: {
        name: params.name,
        labels: params.labels,
        primaryDisplayProperty: params.primary_field_id,
        properties: params.fields.map(
          (
            field,
          ): Oas_crm_schemas['components']['schemas']['ObjectTypePropertyCreate'] => ({
            name: field.id,
            label: field.label,
            ...(() => {
              switch (field.type) {
                case 'text':
                  return {type: 'string', fieldType: 'text'}
                case 'textarea':
                  return {type: 'string', fieldType: 'textarea'}
                case 'number':
                  return {type: 'number', fieldType: 'number'}
                case 'picklist':
                case 'multipicklist':
                  return {
                    type: 'enumeration',
                    fieldType:
                      field.type === 'picklist' ? 'select' : 'checkbox',
                    options: field.options?.map((option, idx) => ({
                      label: option.label,
                      value: option.value,
                      description: option.description,
                      hidden: option.hidden ?? false,
                      displayOrder: idx + 1,
                    })),
                  }
                case 'date':
                  return {type: 'date', fieldType: 'date'}
                case 'datetime':
                  return {type: 'datetime', fieldType: 'date'}
                case 'boolean':
                  return {
                    type: 'bool',
                    fieldType: 'booleancheckbox',
                    options: [
                      {
                        label: 'Yes',
                        value: 'true',
                        displayOrder: 1,
                        hidden: false,
                      },
                      {
                        label: 'No',
                        value: 'false',
                        displayOrder: 2,
                        hidden: false,
                      },
                    ],
                  }
                case 'url':
                  throw new BadRequestError('url type is unsupported')
                default:
                  return {type: 'string', fieldType: 'text'}
              }
            })(),
          }),
        ),
        requiredProperties: params.fields
          .filter((field) => field.is_required)
          .map((field) => field.id),
        searchableProperties: [],
        secondaryDisplayProperties: [],
        associatedObjects: [],
      },
    })
    return {id: res.data.id, name: res.data.name}
  },
  metadataCreateAssociationSchema: async ({instance, input}) => {
    const [fromObjectType, toObjectType] = await Promise.all([
      getObjectTypeFromNameOrId(instance, input.source_object),
      getObjectTypeFromNameOrId(instance, input.target_object),
    ])

    // Would be great to have a way to annotate sdk-hubspot that crm_crm_associations corresponds to the v4 associations API
    // while crm_associations corresponds to the v3 associations API
    // The path is also super misleading here as it includes `labels`. but it corresponds to `hubspot.crm.associations.v4.schema.definitionsApi.create`
    await instance.crm_crm_associations.POST(
      '/{fromObjectType}/{toObjectType}/labels',
      {
        params: {path: {fromObjectType, toObjectType}},
        body: {label: input.display_name, name: input.suggested_key_name},
      },
    )
    // > tony: It's not super clear to me why we need a separate GET request and then filter by label
    // however this is what Supaglue did so keeping it for now
    const res = await instance.crm_crm_associations.GET(
      '/{fromObjectType}/{toObjectType}/labels',
      {params: {path: {fromObjectType, toObjectType}}},
    )

    const created = res.data.results.find(
      (result) => result.label === input.display_name,
    )
    if (!created) {
      throw new InternalServerError('Unable to create association schema')
    }

    return {
      association_schema: {
        id: created.typeId.toString(),
        target_object: toObjectType,
        source_object: fromObjectType,
        display_name: input.display_name,
      },
    }
  },
} satisfies CRMProvider<HubspotSDK>