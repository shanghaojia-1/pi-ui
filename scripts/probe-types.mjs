import { ModelRuntime, getAgentDir } from '@earendil-works/pi-coding-agent'
const runtime = await ModelRuntime.create()
const providers = runtime.getProviders()
console.log('total providers:', providers.length)
const withUrl = providers.filter((p) => p.baseUrl !== undefined)
console.log('with baseUrl:', withUrl.length)
for (const p of withUrl) console.log(`${p.id}\t${p.name}\t${p.baseUrl}`)
