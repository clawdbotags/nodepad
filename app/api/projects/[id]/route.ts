import { NextResponse } from "next/server"
import { getProject, updateProject, deleteProject, listNotes } from "@/lib/server/db"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const project = getProject(id)
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    const notes = listNotes(id)
    return NextResponse.json({ ...project, notes })
  } catch (e: any) {
    console.error("GET /api/projects/[id] failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const { name } = body
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }
    const existing = getProject(id)
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    const project = updateProject(id, name)
    return NextResponse.json(project)
  } catch (e: any) {
    console.error("PUT /api/projects/[id] failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    deleteProject(id)
    return new NextResponse(null, { status: 204 })
  } catch (e: any) {
    console.error("DELETE /api/projects/[id] failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
