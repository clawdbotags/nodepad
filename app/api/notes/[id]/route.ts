import { NextResponse } from "next/server"
import { updateNote, deleteNote } from "@/lib/server/db"

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const note = updateNote(id, {
      text: body.text,
      content_type: body.content_type,
      category: body.category,
      annotation: body.annotation,
      influenced_by: body.influenced_by,
      is_unrelated: body.is_unrelated,
      merge_with: body.merge_with,
      sources: body.sources,
      is_enriching: body.is_enriching,
      is_ghost: body.is_ghost,
    })
    return NextResponse.json(note)
  } catch (e: any) {
    console.error("PUT /api/notes/[id] failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    deleteNote(id)
    return new NextResponse(null, { status: 204 })
  } catch (e: any) {
    console.error("DELETE /api/notes/[id] failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
