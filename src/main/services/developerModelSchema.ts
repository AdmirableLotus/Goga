export function developerModelSchema(spanIds:string[]) {
  if(!spanIds.length||spanIds.length>32||spanIds.some(id=>!/^F1$|^S\d{1,2}$/.test(id)))throw Error('Invalid developer source-span catalog.')
  return {
  type:'object', additionalProperties:false, properties:{
    explanation:{type:'string'},
    sourceSpanIds:{type:'array',minItems:1,maxItems:2,items:{enum:spanIds}},
    replacement:{oneOf:[{type:'null'},{type:'string'}]},
    uncertainty:{type:'string'}
  }
}
}
