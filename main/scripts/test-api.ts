import {initBYOSupaglueSDK} from '@supaglue/sdk'
import graphqlWorker from '@supaglue/worker/graphql'

const supaglue = initBYOSupaglueSDK({
  headers: {
    'x-connection-id': 'test-connection-id',
    'x-provider-name': 'outreach',
  },
})

async function main() {
  let cursor: string | undefined = undefined

  while (true) {
    const r = await supaglue.GET('/engagement/v2/sequences', {
      params: {query: {cursor}},
    })
    console.log('Success', r.data)

    // Call the getData function from graphqlWorker aand handle the response
    try {
      const batchData = await graphqlWorker.getData();
      console.log('GraphQL Data:', batchData);
    } catch (error) {
      console.error('GraphQL Error:', error);
    }

    // Break the loop if there is no nextPageCursor
    if (!r.data.nextPageCursor) {
      break;
    }
    cursor = r.data.nextPageCursor as string | undefined
  }
}

main()

// const supaglue = initBYOSupaglueSDK({
//   headers: {
//     'x-connection-id': 'hubspot1',
//     'x-provider-name': 'hubspot',
//   },
// })

// supaglue.GET('/crm/v2/contacts').then((r) => {
//   if (r.error) {
//     console.log('Error', r.error)
//   } else {
//     console.log('Success', r.data)
//   }
// })
