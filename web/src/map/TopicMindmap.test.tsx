import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TopicMindmap } from './TopicMindmap'
import { partitionTopicMap, safeTopicBranches } from './topicMapModel'

describe('TopicMindmap', () => {
  it('renders branches and documents, drills down on branch click, and supports fullscreen/zoom controls', () => {
    const branches = safeTopicBranches([
      {
        label: 'Courses',
        documents: [
          { documentId: 1, title: 'LYT Course MOC', path: 'LYT.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          { documentId: 2, title: 'Notes MOC', path: 'Notes.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
        ],
      },
      {
        label: 'Habits',
        documents: [
          { documentId: 3, title: 'Habits MOC LYT', path: 'Habits.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          { documentId: 4, title: 'Daily Loop', path: 'Daily.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
        ],
      },
    ])
    const partitioned = partitionTopicMap(branches)
    const onBranch = vi.fn()

    render(
      <TopicMindmap
        topic="000 Home"
        branches={branches}
        partitioned={partitioned}
        onBranch={onBranch}
      />,
    )

    expect(screen.getByRole('img', { name: /2D mindmap for 000 Home/ })).toBeTruthy()
    expect(screen.getByText('000 Home', { selector: 'text' })).toBeTruthy()
    expect(screen.getByText('Courses', { selector: 'text' })).toBeTruthy()
    expect(screen.getByText('LYT Course MOC', { selector: 'text' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Courses' }))
    expect(onBranch).toHaveBeenCalledWith('Courses')

    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeTruthy()
    expect(screen.getByText('Exit')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Exit full screen' })).toBeNull()
  })
})
