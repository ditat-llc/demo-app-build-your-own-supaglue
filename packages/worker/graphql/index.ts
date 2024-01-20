import { gql, GraphQLClient } from 'graphql-request'
import {env} from '../env'

const client = new GraphQLClient(env.NHOST_GRAPHQL_URL, {
  headers: {
    ['x-hasura-admin-secret']: env.NHOST_ADMIN_SECRET
  }
})

interface UserData {
  user: {
    org_user: {
      organization: {
        paymentProfile: {
          stripeCustomerId: string
        }
      }
    }
  }
}

// Define the graphql operations below

const getUserById = async (userId: string): Promise<UserData> => {
  const query = gql`
    query getUser($id: uuid!) @cached(ttl: 120) {
      user(id: $id) {
        org_user {
          organization {
            paymentProfile {
              stripeCustomerId
            }
          }
        }
      }
    }
  `
  return await client.request<UserData>(query, { id: userId })
}

const graphqlWorker = {
  getUserById
}

export default graphqlWorker
