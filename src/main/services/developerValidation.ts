import { Worker } from 'worker_threads'
import { sha256 } from './developerRepository'
import type { DeveloperValidation } from '../../shared/types'

// Trusted evaluator, NOT eval/VM execution of model code. No repository imports.
export const validationWorker = String.raw`
const {parentPort,workerData}=require('worker_threads');
const ts=require(workerData.typescript);
try {
 const file=ts.createSourceFile('candidate.ts',workerData.source,ts.ScriptTarget.Latest,true);
 if(file.parseDiagnostics.length || file.statements.length!==1)throw Error('Unsupported function syntax.');
 const fn=file.statements[0];
 if(!ts.isFunctionDeclaration(fn)||fn.name?.text!=='formatBytes'||!fn.body||fn.parameters.length!==1||fn.modifiers?.length||fn.asteriskToken)throw Error('Only a plain formatBytes function is supported.');
 const parameter=fn.parameters[0];
 if(!ts.isIdentifier(parameter.name)||parameter.name.text!=='b'||parameter.type?.kind!==ts.SyntaxKind.NumberKeyword||parameter.initializer||parameter.dotDotDotToken)throw Error('One numeric parameter is required.');
 const allowed=new Set(['FunctionDeclaration','Identifier','Parameter','NumberKeyword','StringKeyword','Block','IfStatement','ReturnStatement','VariableStatement','VariableDeclarationList','VariableDeclaration','NumericLiteral','StringLiteral','NoSubstitutionTemplateLiteral','TemplateExpression','TemplateSpan','TemplateHead','TemplateMiddle','TemplateTail','ParenthesizedExpression','PrefixUnaryExpression','BinaryExpression','ConditionalExpression','CallExpression','PropertyAccessExpression','TrueKeyword','FalseKeyword','NullKeyword','PlusToken','MinusToken','AsteriskToken','SlashToken','PercentToken','LessThanToken','LessThanEqualsToken','GreaterThanToken','GreaterThanEqualsToken','EqualsEqualsEqualsToken','ExclamationEqualsEqualsToken','AmpersandAmpersandToken','BarBarToken','QuestionQuestionToken','ExclamationToken'].map(name=>ts.SyntaxKind[name]));
 let nodes=0;
 const permittedCall=n=>ts.isPropertyAccessExpression(n.expression)&&(
   (ts.isIdentifier(n.expression.expression)&&n.expression.expression.text==='Number'&&['isFinite','isNaN'].includes(n.expression.name.text)&&n.arguments.length===1)||
   (n.expression.name.text==='toFixed'&&n.arguments.length===1));
 function check(n,depth=0){
  if(++nodes>512||depth>48)throw Error('Syntax complexity limit.');
  if(!allowed.has(n.kind)|| (ts.isFunctionDeclaration(n)&&n!==fn))throw Error('Unsupported pure-function syntax.');
  if(ts.isVariableStatement(n)&&(n.parent!==fn.body||!(n.declarationList.flags&ts.NodeFlags.Const)))throw Error('Only function-local constants are supported.');
  if(ts.isVariableDeclaration(n)&&(!ts.isIdentifier(n.name)||['Number','NaN','Infinity'].includes(n.name.text)))throw Error('Reserved variable name.');
  if(ts.isCallExpression(n)&&!permittedCall(n))throw Error('External or dynamic calls are not allowed.');
  if(ts.isPropertyAccessExpression(n)&& !ts.isCallExpression(n.parent))throw Error('Property reads are not allowed.');
  ts.forEachChild(n,c=>check(c,depth+1));
 }
 check(fn);
 function run(input){
  let operations=0;const values=new Map([[parameter.name.text,input]]);
  function tick(){if(++operations>2000)throw Error('Operation limit.');}
  function expr(n){
   tick();
   if(ts.isNumericLiteral(n))return Number(n.text);
   if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;
   if(n.kind===ts.SyntaxKind.TrueKeyword)return true;
   if(n.kind===ts.SyntaxKind.FalseKeyword)return false;
   if(n.kind===ts.SyntaxKind.NullKeyword)return null;
   if(ts.isIdentifier(n)){if(n.text==='NaN')return NaN;if(n.text==='Infinity')return Infinity;if(!values.has(n.text))throw Error('Unknown variable.');return values.get(n.text);}
   if(ts.isParenthesizedExpression(n))return expr(n.expression);
   if(ts.isPrefixUnaryExpression(n)){const v=expr(n.operand);if(n.operator===ts.SyntaxKind.ExclamationToken)return !v;if(n.operator===ts.SyntaxKind.MinusToken)return -v;if(n.operator===ts.SyntaxKind.PlusToken)return +v;throw Error('Unsupported unary operation.');}
   if(ts.isConditionalExpression(n))return expr(n.condition)?expr(n.whenTrue):expr(n.whenFalse);
   if(ts.isTemplateExpression(n))return n.head.text+n.templateSpans.map(s=>String(expr(s.expression))+s.literal.text).join('');
   if(ts.isBinaryExpression(n)){
    const a=expr(n.left),op=n.operatorToken.kind;
    if(op===ts.SyntaxKind.AmpersandAmpersandToken)return a&&expr(n.right);
    if(op===ts.SyntaxKind.BarBarToken)return a||expr(n.right);
    if(op===ts.SyntaxKind.QuestionQuestionToken)return a??expr(n.right);
    const b=expr(n.right);
    switch(op){case ts.SyntaxKind.PlusToken:return a+b;case ts.SyntaxKind.MinusToken:return a-b;case ts.SyntaxKind.AsteriskToken:return a*b;case ts.SyntaxKind.SlashToken:return a/b;case ts.SyntaxKind.PercentToken:return a%b;case ts.SyntaxKind.LessThanToken:return a<b;case ts.SyntaxKind.LessThanEqualsToken:return a<=b;case ts.SyntaxKind.GreaterThanToken:return a>b;case ts.SyntaxKind.GreaterThanEqualsToken:return a>=b;case ts.SyntaxKind.EqualsEqualsEqualsToken:return a===b;case ts.SyntaxKind.ExclamationEqualsEqualsToken:return a!==b;default:throw Error('Unsupported operator.');}
   }
   if(ts.isCallExpression(n)&&permittedCall(n)){
    const access=n.expression,arg=expr(n.arguments[0]);
    if(ts.isIdentifier(access.expression)&&access.expression.text==='Number')return access.name.text==='isFinite'?Number.isFinite(arg):Number.isNaN(arg);
    const number=expr(access.expression);
    if(typeof number!=='number'||!Number.isInteger(arg)||arg<0||arg>20)throw Error('Invalid fixed-decimal operation.');
    return Number.prototype.toFixed.call(number,arg);
   }
   throw Error('Unsupported expression.');
  }
  function statement(n){
   tick();
   if(ts.isReturnStatement(n))return {returned:true,value:n.expression?expr(n.expression):undefined};
   if(ts.isBlock(n)){for(const s of n.statements){const v=statement(s);if(v)return v;}return;}
   if(ts.isIfStatement(n))return expr(n.expression)?statement(n.thenStatement):n.elseStatement?statement(n.elseStatement):undefined;
   if(ts.isVariableStatement(n)){for(const d of n.declarationList.declarations){if(!ts.isIdentifier(d.name)||!d.initializer||values.has(d.name.text))throw Error('Unsupported variable declaration.');values.set(d.name.text,expr(d.initializer));}return;}
   throw Error('Unsupported statement.');
  }
  return statement(fn.body)?.value;
 }
 const cases=[['zero',0,'0 B'],['bytes',12,'12 B'],['byte boundary',1023,'1023 B'],['kilobyte',1024,'1.0 KB'],['fractional KB',1536,'1.5 KB'],['megabyte',1048576,'1.0 MB'],['fractional MB',1572864,'1.5 MB'],['existing large value',1073741824,'1024.0 MB'],['negative',-1,'0 B'],['NaN',NaN,'0 B'],['positive infinity',Infinity,'0 B'],['negative infinity',-Infinity,'0 B']].map(([name,input,expected])=>{let actual;try{actual=run(input);}catch{actual='[interpreter rejected]';}return {name,expected,actual:String(actual).slice(0,200),passed:actual===expected};});
 parentPort.postMessage({syntaxPassed:true,cases,passed:cases.every(c=>c.passed)});
}catch{parentPort.postMessage({syntaxPassed:false,cases:[],passed:false});}
`
export const validationPolicyHash = sha256(validationWorker)
export async function validateFormatter(source: string, signal: AbortSignal, timeoutMs=3000): Promise<DeveloperValidation> {
  signal.throwIfAborted()
  if(source.length>10_000)throw Error('Candidate function exceeds the validation limit.')
  const start=Date.now()
  return new Promise((resolve,reject)=>{
    const worker=new Worker(validationWorker,{eval:true,workerData:{source,typescript:require.resolve('typescript')},
      resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}})
    let result: any, stopping=false, failure: string | undefined
    const stop=(reason?:string)=>{if(stopping)return;stopping=true;failure=reason;void worker.terminate().catch(()=>{})}
    const abort=()=>stop('Developer validation stopped.')
    const timer=setTimeout(()=>stop('Developer validation timed out.'),timeoutMs)
    signal.addEventListener('abort',abort,{once:true})
    if(signal.aborted)abort()
    worker.on('message',value=>{if(!stopping){result=value;stop()}})
    worker.on('error',()=>stop('Developer validation worker failed.'))
    worker.on('exit',()=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort)
      if(failure||!result||signal.aborted)return reject(Error(failure??'Developer validation stopped.'))
      resolve({...result,kind:'pure-helper-interpreter',durationMs:Date.now()-start,policyHash:validationPolicyHash,
        limitation:'12 fixed pure-function cases and an allowlisted AST check. No candidate JavaScript, repository scripts, integration tests, or full application build executed.'})
    })
  })
}
