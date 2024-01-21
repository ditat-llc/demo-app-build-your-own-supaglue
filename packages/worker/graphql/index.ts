import { gql, GraphQLClient } from 'graphql-request'
import {env} from '../env'

const client = new GraphQLClient(env.NHOST_GRAPHQL_URL, {
  headers: {
    ['x-hasura-admin-secret']: env.NHOST_ADMIN_SECRET
  }
})

interface BatchData {
  batch: {
    id: string
    status: string
    created_at: string
  }
}

// Define the graphql operations below

const getData = async (): Promise<BatchData> => {
  const query = gql`
    query myQuery {
      email_validation_batches(limit: 1, order_by: {created_at: asc}) {
        id
        status
        created_at
      }
    }
  `
  return await client.request<BatchData>(query)
}

interface DataConnection {
  data_connection: Array<{
    id: number
  }>
}
const getDataConnectionTest = async (): Promise<DataConnection> => {
  const query = gql`
    query DataConnectionQuery {
      data_connection {
        id
        owner_id
      }
    }
  `
  return await client.request<DataConnection>(query)
}

const graphqlWorker = {
  getData,
  getDataConnectionTest
}

export default graphqlWorker
