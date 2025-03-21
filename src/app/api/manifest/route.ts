export const runtime = "nodejs";




export async function GET() {
    console.log('EHUIWEHUEIRREHIUW')
    return new Response(JSON.stringify({ error: 'Expected GET.' }), { status: 200 });
}