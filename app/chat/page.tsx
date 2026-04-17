import { redirect } from "next/navigation"

/**
 * /chat used to be its own top-level route with its own ChatView. That
 * forced a full page reload between Nodes and Rooms, losing canvas
 * state and the Matrix long-poll on every toggle. Chat is now an
 * overlay on `/` controlled by local state, so `/chat` just bounces to
 * `/?view=rooms` — same URL still works for bookmarks / direct links.
 */
export default function ChatPage() {
  redirect("/?view=rooms")
}
