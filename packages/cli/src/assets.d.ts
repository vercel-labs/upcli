// Text assets imported as strings (esbuild "text" loader, configured in tsup).
declare module "*.txt" {
  const content: string;
  export default content;
}
