import { NextResponse } from "next/server"
import { listNotes, createNote, getProject } from "@/lib/server/db"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const notes = listNotes(id)
    return NextResponse.json(notes)
  } catch (e: any) {
    console.error("GET /api/projects/[id]/notes failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params
    const body = await request.json()

    // Auto-create project if it doesn't exist (handles initial default project)
    const project = getProject(projectId)
    if (!project) {
      const { createProject } = await import("@/lib/server/db")
      createProject(projectId, body.project_name || "Default Space")
    }

    const note = createNote({
      id: body.id || Math.random().toString(36).substring(2, 10),
      project_id: projectId,
      text: body.text,
      content_type: body.content_type,
      category: body.category,
      annotation: body.annotation,
      influenced_by: body.influenced_by,
      is_unrelated: body.is_unrelated,
      sources: body.sources,
      is_enriching: body.is_enriching,
      is_ghost: body.is_ghost,
      created_at: body.created_at,
    })
    return NextResponse.json(note, { status: 201 })
  } catch (e: any) {
    console.error("POST /api/projects/[id]/notes failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
