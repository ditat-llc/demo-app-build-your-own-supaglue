import {TRPCError} from '@trpc/server'
import {HTTPError} from '@opensdks/runtime'
import {z} from '@opensdks/util-zod'

export const zErrorType = z.enum([
  'USER_ERROR', // authentication & configuration issue for user to fix...
  'REMOTE_ERROR', // remote provider error, corresponds to 5xx codes
  'INTERNAL_ERROR', // Our platform error, corresdponds to 4xx codes
])

export type ErrorType = z.infer<typeof zErrorType>

/** Refreshing token failed / access revoked */
export class NoLongerAuthenticatedError extends TRPCError {
  // Cannot modify the name as it is used by trpc internals to determine if it's a trpc error...
  // the alternative is to use error.constructor.name instead which works out ok.
  // override name = 'NoLongerAuthenticatedError'

  constructor(
    public readonly customerId: string,
    public readonly providerName: string,
    public readonly description: string,
    public readonly extraInfo: unknown,
  ) {
    super({
      code: 'UNAUTHORIZED',
      message: `${customerId}/${providerName}: ${description}`,
    })
  }
}

/** TODO: MOve me into opensdks/runtime */
export function isHttpError<T>(
  err: unknown,
  /** HTTPError code. TODO: Support range... */
  code?: number,
): err is HTTPError<T> {
  if (err instanceof HTTPError) {
    if (code == null || err.code === code) {
      return true
    }
  }
  return false
}

/** Handles error from both within and out of the process. Used for displaying in UI / saving to DB etc. */
export function parseErrorInfo(err: unknown):
  | {
      error_type: ErrorType
      error_detail: string
    }
  | undefined {
  // Error from hitting our own server from say sdk
  const ourError =
    err instanceof HTTPError ? zTrpcErrorShape.safeParse(err.error) : null
  if (ourError?.success) {
    return {
      error_type:
        // TODO: separate remote provider error from platform error from client error
        ourError.data.class === NoLongerAuthenticatedError.name
          ? 'USER_ERROR'
          : 'INTERNAL_ERROR',
      error_detail: [ourError.data.message, `\t-> ${err}`].join('\n'),
    }
  }

  // Error from hitting external servers, including those returned by fetch middlewares
  if (err instanceof NoLongerAuthenticatedError) {
    return {error_type: 'USER_ERROR', error_detail: err.message}
  }

  // Anything else non-null would be considered internal error.
  if (err != null) {
    return {error_type: 'INTERNAL_ERROR', error_detail: `${err}`}
  }
  return undefined
}

export const zTrpcErrorShape = z.object({
  /** Custom xtended by us */
  class: z.string(),
  code: z.string(),
  message: z.string(),
  data: z.unknown(),
})

export {HTTPError}
