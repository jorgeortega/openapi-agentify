export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return Response.json({ id: (await params).id });
}

export const DELETE = async () => new Response(null, { status: 204 });
