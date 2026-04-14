import { NextResponse } from "next/server"
import { listProjects, createProject } from "@/lib/server/db"

export async function GET() {
  try {
    const projects = listProjects()
    return NextResponse.json(projects)
  } catch (e: any) {
    console.error("GET /api/projects failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { id, name } = body
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }
    const projectId = id || Math.random().toString(36).substring(2, 10)
    const project = createProject(projectId, name)
    return NextResponse.json(project, { status: 201 })
  } catch (e: any) {
    console.error("POST /api/projects failed:", e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
