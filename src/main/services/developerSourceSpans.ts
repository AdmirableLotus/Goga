import type { DeveloperInspection, DeveloperSourceSpan } from '../../shared/types'

/** IDs live only inside this pinned inspection; the model never supplies quote bytes. */
export function sourceSpans(view:DeveloperInspection):DeveloperSourceSpan[]{
  const spans:DeveloperSourceSpan[]=[{id:'F1',startLine:view.startLine,endLine:view.endLine,quote:view.functionText}]
  view.functionText.split('\n').forEach((quote,index)=>{
    if(quote.trim()&&spans.length<32)spans.push({id:`S${spans.length}`,startLine:view.startLine+index,endLine:view.startLine+index,quote})
  })
  return spans
}
