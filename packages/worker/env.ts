import {createEnv} from '@t3-oss/env-core'
import {z} from 'zod'
import {initNangoSDK} from '@opensdks/sdk-nango'

console.log(process.env)

// Dedupe this with main/env.ts
export const env = createEnv({
  server: {
    NANGO_SECRET_KEY: z.string(),
    POSTGRES_URL: z.string(),
    NHOST_GRAPHQL_URL: z.string(),
    NHOST_WEBHOOK_SECRET: z.string()
  },
  runtimeEnv: process.env,
})

export const nango = initNangoSDK({
  headers: {authorization: `Bearer ${env.NANGO_SECRET_KEY}`},
})
