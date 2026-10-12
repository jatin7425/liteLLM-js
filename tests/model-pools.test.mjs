import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { modelId, poolCatalog, addAliases } from '../api/model_pools.js';

const config=yaml.load(readFileSync(new URL('../config.yaml',import.meta.url),'utf8'));
test('catalog uses actual model IDs, splits NVIDIA models, and identifies non-chat modes',()=>{
 const catalog=poolCatalog(config),ids=catalog.map(item=>item.id);
 assert(ids.includes('gemini-3.5-flash'));
 assert(ids.includes('openai/gpt-oss-120b'));
 assert(ids.includes('nvidia/nemotron-3-super-120b-a12b'));
 assert(ids.includes('nvidia/nemotron-3-nano-30b-a3b'));
 assert(!ids.includes('gemini'));assert(!ids.includes('nvidia'));
 assert.equal(catalog.find(item=>item.id==='gemini-embedding-001').mode,'embedding');
 assert.equal(catalog.find(item=>item.id==='whisper-large-v3-turbo').mode,'transcription');
});
test('legacy aliases stay routable but do not appear in model listings',()=>{
 const pools={};for(const entry of config.model_list){const id=modelId(entry);pools[id]??={items:[],rr:0};pools[id].items.push({name:id});}
 addAliases(pools,config);
 assert(pools.gemini.items.length>0);assert(pools.nvidia.items.some(item=>item.name.includes('super')));assert(pools.nvidia.items.some(item=>item.name.includes('nano')));
 assert(!Object.keys(pools).includes('gemini'));assert(!Object.keys(pools).includes('nvidia'));
});
test('gateway forwards canonical and legacy model names, reports pool rate limits',async()=>{
 const upstream=createServer((request,response)=>{let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{const body=JSON.parse(text);response.setHeader('Content-Type','application/json');response.end(JSON.stringify({model:body.model,choices:[{message:{content:'ok'}}]}));});});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${upstream.address().port}/v1`;
 process.env.LITELLM_CONFIG_JSON=JSON.stringify({general_settings:{master_key:'fixture'},model_list:[{model_name:'actual-model',legacy_names:['old-provider'],mode:'chat',litellm_params:{model:'openai/actual-model',api_base:url,api_key:'fixture',rpm:2}}]});
 const {default:handler}=await import('../api/index.js');
 const invoke=async(name)=>{const response={headers:{},statusCode:0,setHeader(key,value){this.headers[key]=value;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},send(body){this.body=Buffer.isBuffer(body)?JSON.parse(body.toString()):body;return this;}};await handler({url:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:{model_name:name,messages:[{role:'user',content:'hello'}]}},response);return response;};
 try{
  const first=await invoke('actual-model');assert.equal(first.statusCode,200);assert.equal(first.body.model,'actual-model');
  const second=await invoke('old-provider');assert.equal(second.statusCode,200);assert.equal(second.body.model,'actual-model');
  const third=await invoke('actual-model');assert.equal(third.statusCode,429);assert.equal(third.headers['Retry-After'],'60');assert.equal(third.body.error.code,'provider_limit');
 }finally{await new Promise(resolve=>upstream.close(resolve));}
});
