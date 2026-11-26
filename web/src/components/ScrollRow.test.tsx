import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScrollRow } from './ScrollRow'

// jsdom has no layout, so give the row a size: 200px wide, 500px of content.
function sized(row: HTMLElement): HTMLElement {
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: 200 })
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 500 })
  return row
}

describe('ScrollRow', () => {
  it('turns a vertical wheel into sideways scrolling and marks the edges with more content', () => {
    render(
      <ScrollRow data-testid="row">
        <span>a</span>
      </ScrollRow>,
    )
    const row = sized(screen.getByTestId('row'))

    row.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }))
    expect(row.scrollLeft).toBe(120)

    row.dispatchEvent(new Event('scroll'))
    expect(row.hasAttribute('data-more-start')).toBe(true)
    expect(row.hasAttribute('data-more-end')).toBe(true)
  })

  it('hands the wheel back to the page at the end of the row', () => {
    render(
      <ScrollRow data-testid="row">
        <span>a</span>
      </ScrollRow>,
    )
    const row = sized(screen.getByTestId('row'))
    row.scrollLeft = 300

    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true })
    row.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)

    row.dispatchEvent(new Event('scroll'))
    expect(row.hasAttribute('data-more-end')).toBe(false)
  })
})
