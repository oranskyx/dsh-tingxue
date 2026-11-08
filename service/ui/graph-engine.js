/* dsh-tingxue · service/ui/graph-engine.js
 *
 * 记忆图谱的 canvas 力导向渲染引擎：零依赖、无 import。
 * 渲染与交互逻辑复制自 src/graph-dashboard/index.mjs 里的蜘蛛网实现，并按管理界面需求扩展：
 *   - 聚类布局、斥力/弹簧/阻尼、速度钳制、初始收敛与拖拽后局部收敛
 *   - 以鼠标为中心缩放、拖动节点、空白拖动平移、点击选中、hover 邻域高亮
 *   - 标签碰撞避让、搜索高亮、类型过滤调暗、选中节点高亮
 *   - 右下角控制按钮（回中/放大/缩小/适应视图/小地图模式）由 app.js 调用
 *   - 小地图：全图缩略 + 视口框（标准），或当前视口 + 全图提示（鹰眼）
 *
 * 与旧面板不同：所有颜色都不写死，逐帧从 CSS 语义变量读取，主题切换后 refreshTheme() 立即重绘。
 * 对外接口：window.TXGraph.create(canvas, { onSelect })
 */
(function (global) {
  'use strict'

  var TAU = Math.PI * 2
  var MINIMAP_W = 168
  var MINIMAP_H = 108
  var MINIMAP_MARGIN = 14

  // 力导向物理参数（集中定义，便于调参）
  var PHYSICS = {
    repulsionForce: 3200,
    repulsionDist: 260,
    springRest: 90,
    springK: 0.03,
    damping: 0.85,
    centerX: 0.01,
    centerY: 0.008,
    maxVel: 12,
    maxTicks: 300,
    resumeTicks: 90
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value
  }

  function readVar(styles, name, fallback) {
    var value = styles.getPropertyValue(name)
    value = value ? value.trim() : ''
    return value || fallback
  }

  /** 把 rgba(...) 变成同色 alpha=0，避免径向渐变末端向黑色插值（浅色主题会发灰）。 */
  function fadeToTransparent(color) {
    var match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(color || ''))
    if (match) return 'rgba(' + match[1] + ',' + match[2] + ',' + match[3] + ',0)'
    return 'transparent'
  }

  function create(canvas, options) {
    options = options || {}
    var stage = canvas.parentElement || document.body
    var ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持 canvas 2d')

    var onSelect = typeof options.onSelect === 'function' ? options.onSelect : function () {}
    var onClearSelection = typeof options.onClearSelection === 'function' ? options.onClearSelection : function () {}
    var reduceMotion = false
    try {
      reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (error) { /* 忽略 */ }

    // ---- 状态 ----
    var dpr = Math.min(2, global.devicePixelRatio || 1)
    var size = { w: 0, h: 0 }
    var colors = null

    var nodes = []
    var edges = []
    var positions = []
    var velocities = []
    var byId = new Map()
    var adjacency = []

    var selectedId = null
    var selectedEdgeId = null
    var hoverIndex = -1
    var query = ''
    var typeFilter = 'all'

    var zoom = 1
    var panX = 0
    var panY = 0

    var dragIndex = -1
    var viewDragging = false
    var activePointerId = null
    var lastPointer = { x: 0, y: 0 }
    var downPointer = { x: 0, y: 0 }
    var pointerMoved = false

    var animationOn = false
    var tickCount = 0
    var frameId = 0
    var staticScheduled = false
    var hasLayout = false
    var minimapMode = 'standard'
    var destroyed = false

    // ================= 主题颜色 =================
    function readColors() {
      var styles = global.getComputedStyle(document.documentElement)
      var types = {}
      var glows = {}
      var glowsEnd = {}
      ;['person', 'place', 'thing', 'concept', 'unknown'].forEach(function (key) {
        types[key] = readVar(styles, '--type-' + key, '#8b96a8')
        glows[key] = readVar(styles, '--type-' + key + '-glow', 'rgba(139,150,168,.25)')
        glowsEnd[key] = fadeToTransparent(glows[key])
      })
      colors = {
        bg: readVar(styles, '--graph-bg', '#fbfcff'),
        grid: readVar(styles, '--graph-grid', 'rgba(90,110,150,.08)'),
        edge: readVar(styles, '--graph-edge', 'rgba(70,95,150,.24)'),
        edgeActive: readVar(styles, '--graph-edge-active', 'rgba(57,103,214,.6)'),
        edgeDim: readVar(styles, '--graph-edge-dim', 'rgba(70,95,150,.08)'),
        label: readVar(styles, '--graph-label', '#26303f'),
        labelDim: readVar(styles, '--graph-label-dim', 'rgba(38,48,63,.3)'),
        nodeStroke: readVar(styles, '--graph-node-stroke', 'rgba(255,255,255,.9)'),
        ring: readVar(styles, '--graph-focus-ring', '#3967d6'),
        minimapBg: readVar(styles, '--graph-minimap-bg', 'rgba(250,252,255,.9)'),
        minimapBorder: readVar(styles, '--graph-minimap-border', 'rgba(84,104,142,.34)'),
        minimapViewport: readVar(styles, '--graph-minimap-viewport', 'rgba(38,48,63,.72)'),
        type: types,
        glow: glows,
        glowEnd: glowsEnd
      }
    }

    // ================= 尺寸 =================
    function resize() {
      var width = Math.max(0, Math.round(canvas.clientWidth || stage.clientWidth || 0))
      var height = Math.max(0, Math.round(canvas.clientHeight || stage.clientHeight || 0))
      if (!width || !height) return false
      size.w = width
      size.h = height
      dpr = Math.min(2, global.devicePixelRatio || 1)
      var bufferWidth = Math.round(width * dpr)
      var bufferHeight = Math.round(height * dpr)
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth
        canvas.height = bufferHeight
      }
      return true
    }

    /** 节点基础半径：随视口尺寸自适应。 */
    function baseRadius() {
      return clamp(Math.min(size.w || 900, size.h || 600) / 50, 9, 20)
    }

    function nodeRadius() {
      return baseRadius() * 0.52
    }

    // ================= 数据 =================
    function nodeText(node) {
      return ((node.name || '') + ' ' + (node.summary || '')).toLowerCase()
    }

    function nodeMatches(node) {
      if (typeFilter && typeFilter !== 'all' && (node.type || 'concept') !== typeFilter) return false
      if (query && nodeText(node).indexOf(query) < 0) return false
      return true
    }

    function clusterCenters() {
      var counts = {}
      nodes.forEach(function (node) {
        var type = node.type || 'unknown'
        counts[type] = (counts[type] || 0) + 1
      })
      var types = Object.keys(counts)
      var centers = {}
      var cx = (size.w || 900) / 2
      var cy = (size.h || 600) / 2
      var ring = Math.min(size.w || 900, size.h || 600) * 0.32
      types.forEach(function (type, index) {
        var angle = types.length === 1 ? 0 : (index / types.length) * TAU - Math.PI / 2
        centers[type] = { x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring }
      })
      return centers
    }

    function setData(nextNodes, nextEdges) {
      var previous = new Map()
      nodes.forEach(function (node, index) {
        if (positions[index]) previous.set(node.id, { position: positions[index], velocity: velocities[index] })
      })

      nodes = (nextNodes || []).map(function (node) {
        return {
          id: String(node.id == null ? '' : node.id),
          name: String(node.name == null ? '' : node.name),
          type: String(node.type || 'concept'),
          summary: String(node.summary == null ? '' : node.summary)
        }
      })

      byId = new Map()
      nodes.forEach(function (node, index) { byId.set(node.id, index) })

      edges = (nextEdges || []).map(function (edge) {
        var source = edge.source != null ? edge.source : edge.sourceId
        var target = edge.target != null ? edge.target : edge.targetId
        return {
          id: String(edge.id == null ? '' : edge.id),
          source: String(source == null ? '' : source),
          target: String(target == null ? '' : target),
          label: String(edge.label != null ? edge.label : edge.relation || '')
        }
      })
      edges.forEach(function (edge) {
        edge._s = byId.has(edge.source) ? byId.get(edge.source) : -1
        edge._t = byId.has(edge.target) ? byId.get(edge.target) : -1
      })
      edges = edges.filter(function (edge) {
        return edge._s >= 0 && edge._t >= 0 && edge._s !== edge._t
      })

      adjacency = nodes.map(function () { return new Set() })
      edges.forEach(function (edge) {
        adjacency[edge._s].add(edge._t)
        adjacency[edge._t].add(edge._s)
      })

      resize()
      var centers = clusterCenters()
      var nextPositions = new Array(nodes.length)
      var nextVelocities = new Array(nodes.length)
      var spread = Math.min(size.w || 900, size.h || 600) * 0.2
      nodes.forEach(function (node, index) {
        var kept = previous.get(node.id)
        if (kept && isFinite(kept.position.x) && isFinite(kept.position.y)) {
          nextPositions[index] = kept.position
          nextVelocities[index] = kept.velocity && isFinite(kept.velocity.x) ? kept.velocity : { x: 0, y: 0 }
        } else {
          var center = centers[node.type] || { x: (size.w || 900) / 2, y: (size.h || 600) / 2 }
          var angle = Math.random() * TAU
          var radius = spread * Math.sqrt(Math.random())
          nextPositions[index] = {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius
          }
          nextVelocities[index] = { x: 0, y: 0 }
        }
      })
      positions = nextPositions
      velocities = nextVelocities

      if (selectedId && !byId.has(selectedId)) {
        selectedId = null
        onClearSelection()
      }
      if (selectedEdgeId && !edges.some(function (edge) { return edge.id === selectedEdgeId })) {
        selectedEdgeId = null
      }
      if (hoverIndex >= nodes.length) hoverIndex = -1

      var firstLayout = !hasLayout
      hasLayout = true
      if (nodes.length) {
        if (reduceMotion) {
          for (var step = 0; step < (firstLayout ? 220 : 120); step++) simulate()
          animationOn = false
        } else {
          startAnimation(firstLayout ? PHYSICS.maxTicks : PHYSICS.resumeTicks)
        }
      } else {
        animationOn = false
      }
      markDirty()
    }

    // ================= 物理模拟 =================
    function simulate() {
      var count = nodes.length
      if (!count) return
      var activeCount = applyRepulsion(count)
      applySprings(activeCount)
      integrate(activeCount)
    }

    /** 斥力：仅在作用半径内的节点对之间施加；参与数受视口面积限制，避免超大图 O(n²) 卡死。 */
    function applyRepulsion(count) {
      var activeCount = Math.min(count, Math.floor((size.w || 900) * (size.h || 600) * 0.0008))
      for (var i = 0; i < activeCount; i++) {
        var nodeA = positions[i]
        for (var j = i + 1; j < activeCount; j++) {
          var nodeB = positions[j]
          var dx = nodeA.x - nodeB.x
          var dy = nodeA.y - nodeB.y
          var distSq = dx * dx + dy * dy
          if (distSq >= PHYSICS.repulsionDist * PHYSICS.repulsionDist) continue
          var safeDistSq = distSq < 4 ? 4 : distSq
          var dist = Math.sqrt(safeDistSq)
          var force = PHYSICS.repulsionForce / safeDistSq
          var forceX = (dx / dist) * force
          var forceY = (dy / dist) * force
          velocities[i].x += forceX
          velocities[i].y += forceY
          velocities[j].x -= forceX
          velocities[j].y -= forceY
        }
      }
      return activeCount
    }

    function applySprings(activeCount) {
      for (var index = 0; index < edges.length; index++) {
        var edge = edges[index]
        if (edge._s >= activeCount || edge._t >= activeCount) continue
        var a = positions[edge._s]
        var b = positions[edge._t]
        var dx = b.x - a.x
        var dy = b.y - a.y
        var dist = Math.sqrt(dx * dx + dy * dy) || 1
        var force = (dist - PHYSICS.springRest) * PHYSICS.springK
        var forceX = (dx / dist) * force
        var forceY = (dy / dist) * force
        velocities[edge._s].x += forceX
        velocities[edge._s].y += forceY
        velocities[edge._t].x -= forceX
        velocities[edge._t].y -= forceY
      }
    }

    function integrate(activeCount) {
      var centerX = (size.w || 900) / 2
      var centerY = (size.h || 600) / 2
      for (var i = 0; i < activeCount; i++) {
        velocities[i].x += (centerX - positions[i].x) * PHYSICS.centerX
        velocities[i].y += (centerY - positions[i].y) * PHYSICS.centerY
        velocities[i].x *= PHYSICS.damping
        velocities[i].y *= PHYSICS.damping
        var speed = Math.sqrt(velocities[i].x * velocities[i].x + velocities[i].y * velocities[i].y)
        if (speed > PHYSICS.maxVel) {
          var factor = PHYSICS.maxVel / speed
          velocities[i].x *= factor
          velocities[i].y *= factor
        }
        positions[i].x += velocities[i].x
        positions[i].y += velocities[i].y
      }
    }

    function startAnimation(ticks) {
      animationOn = true
      tickCount = Math.max(0, PHYSICS.maxTicks - ticks)
      ensureLoop()
    }

    function ensureLoop() {
      if (frameId || destroyed) return
      frameId = global.requestAnimationFrame(frame)
    }

    function frame() {
      frameId = 0
      if (destroyed) return
      if (animationOn) {
        simulate()
        tickCount += 1
        if (tickCount > PHYSICS.maxTicks) animationOn = false
      }
      draw()
      if (animationOn) ensureLoop()
    }

    function markDirty() {
      if (destroyed || staticScheduled) return
      staticScheduled = true
      global.requestAnimationFrame(function () {
        staticScheduled = false
        if (!animationOn) draw()
      })
    }

    // ================= 坐标 / 视口 =================
    function screenToWorld(screenX, screenY) {
      return { x: (screenX - panX) / zoom, y: (screenY - panY) / zoom }
    }

    function eventPosition(event) {
      var rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    function viewportWorld() {
      return {
        minX: -panX / zoom,
        minY: -panY / zoom,
        maxX: -panX / zoom + size.w / zoom,
        maxY: -panY / zoom + size.h / zoom
      }
    }

    function graphBounds() {
      var minX = Infinity
      var minY = Infinity
      var maxX = -Infinity
      var maxY = -Infinity
      for (var i = 0; i < positions.length; i++) {
        var point = positions[i]
        if (!point) continue
        if (point.x < minX) minX = point.x
        if (point.x > maxX) maxX = point.x
        if (point.y < minY) minY = point.y
        if (point.y > maxY) maxY = point.y
      }
      if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY }
    }

    function hitTest(worldX, worldY) {
      var radius = nodeRadius()
      for (var i = nodes.length - 1; i >= 0; i--) {
        var point = positions[i]
        if (!point) continue
        var dx = point.x - worldX
        var dy = point.y - worldY
        if (dx * dx + dy * dy <= radius * radius * 1.9) return i
      }
      return -1
    }

    /** 以鼠标为中心缩放。 */
    function zoomAt(screenX, screenY, factor) {
      var before = screenToWorld(screenX, screenY)
      zoom = clamp(zoom * factor, 0.2, 5)
      var after = screenToWorld(screenX, screenY)
      panX += (after.x - before.x) * zoom
      panY += (after.y - before.y) * zoom
      markDirty()
    }

    function centerOn(point, targetZoom) {
      if (!point) return
      if (targetZoom) zoom = clamp(targetZoom, 0.2, 5)
      panX = (size.w || 900) / 2 - point.x * zoom
      panY = (size.h || 600) / 2 - point.y * zoom
      markDirty()
    }

    // ================= 绘制 =================
    function draw() {
      if (destroyed) return
      if (!resize()) return
      if (!colors) readColors()
      if (!colors) return

      var width = size.w
      var height = size.h
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = colors.bg
      ctx.fillRect(0, 0, width, height)

      if (nodes.length) {
        var matched = new Array(nodes.length)
        var anyFilter = false
        for (var i = 0; i < nodes.length; i++) {
          matched[i] = nodeMatches(nodes[i])
          if (!matched[i]) anyFilter = true
        }
        var focusIndex = hoverIndex >= 0 ? hoverIndex : (selectedId && byId.has(selectedId) ? byId.get(selectedId) : -1)
        var focusSet = new Set()
        if (focusIndex >= 0) {
          focusSet.add(focusIndex)
          adjacency[focusIndex].forEach(function (index) { focusSet.add(index) })
        }

        ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY)
        drawGrid()
        drawEdges(focusIndex, focusSet, matched, anyFilter)
        drawNodes(focusIndex, focusSet, matched)
        drawLabels(focusIndex, focusSet, matched)
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawMinimap()
    }

    function drawGrid() {
      var view = viewportWorld()
      var step = zoom < 0.45 ? 320 : zoom < 0.85 ? 160 : 80
      var startX = Math.floor(view.minX / step) * step
      var startY = Math.floor(view.minY / step) * step
      ctx.beginPath()
      for (var x = startX; x <= view.maxX; x += step) {
        ctx.moveTo(x, view.minY)
        ctx.lineTo(x, view.maxY)
      }
      for (var y = startY; y <= view.maxY; y += step) {
        ctx.moveTo(view.minX, y)
        ctx.lineTo(view.maxX, y)
      }
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1 / zoom
      ctx.stroke()
    }

    function drawEdges(focusIndex, focusSet, matched, anyFilter) {
      ctx.lineCap = 'round'
      for (var i = 0; i < edges.length; i++) {
        var edge = edges[i]
        var a = positions[edge._s]
        var b = positions[edge._t]
        if (!a || !b) continue
        var color = colors.edge
        var lineWidth = 1.15 / zoom
        var isSelectedEdge = selectedEdgeId != null && edge.id === selectedEdgeId
        if (isSelectedEdge) {
          color = colors.ring
          lineWidth = 2.8 / zoom
        } else if (focusIndex >= 0) {
          if (edge._s === focusIndex || edge._t === focusIndex) {
            color = colors.edgeActive
            lineWidth = 2 / zoom
          } else if (focusSet.has(edge._s) && focusSet.has(edge._t)) {
            color = colors.edge
            lineWidth = 1.4 / zoom
          } else {
            color = colors.edgeDim
            lineWidth = 1 / zoom
          }
        } else if (anyFilter) {
          if (matched[edge._s] && matched[edge._t]) {
            color = colors.edgeActive
            lineWidth = 1.5 / zoom
          } else {
            color = colors.edgeDim
            lineWidth = 1 / zoom
          }
        }
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.strokeStyle = color
        ctx.lineWidth = lineWidth
        ctx.stroke()
      }
    }

    function drawNodes(focusIndex, focusSet, matched) {
      var radius = nodeRadius()
      var glowAll = nodes.length <= 160
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var point = positions[i]
        if (!point) continue
        var isFocus = i === focusIndex
        var isSelected = selectedId != null && node.id === selectedId
        var isMatch = !!query && matched[i]
        var inFocus = focusIndex < 0 || focusSet.has(i)
        var filteredOut = typeFilter && typeFilter !== 'all' && (node.type || 'concept') !== typeFilter
        var queryOut = !!query && !matched[i]
        var alpha = 1
        if (focusIndex >= 0 && !inFocus) alpha = 0.16
        if (queryOut) alpha = Math.min(alpha, 0.12)
        if (filteredOut) alpha = Math.min(alpha, 0.14)

        var bodyRadius = radius * (isMatch ? 1.5 : isFocus ? 1.32 : 1)
        var color = colors.type[node.type] || colors.type.unknown
        var glow = colors.glow[node.type] || colors.glow.unknown
        var glowEnd = colors.glowEnd[node.type] || colors.glowEnd.unknown
        var showGlow = glowAll || isFocus || isSelected || isMatch

        ctx.globalAlpha = alpha
        if (showGlow) {
          var gradient = ctx.createRadialGradient(point.x, point.y, bodyRadius, point.x, point.y, bodyRadius * 3.1)
          gradient.addColorStop(0, glow)
          gradient.addColorStop(1, glowEnd)
          ctx.beginPath()
          ctx.arc(point.x, point.y, bodyRadius * 3.1, 0, TAU)
          ctx.fillStyle = gradient
          ctx.fill()
        }

        ctx.beginPath()
        ctx.arc(point.x, point.y, bodyRadius, 0, TAU)
        ctx.fillStyle = color
        ctx.fill()

        if (isSelected || isMatch || isFocus) {
          ctx.lineWidth = (isSelected ? 2.8 : 2) / zoom
          ctx.strokeStyle = isSelected || isMatch ? colors.ring : colors.nodeStroke
          ctx.stroke()
          if (isSelected) {
            ctx.beginPath()
            ctx.arc(point.x, point.y, bodyRadius + 5 / zoom, 0, TAU)
            ctx.globalAlpha = Math.max(0.18, alpha * 0.55)
            ctx.strokeStyle = colors.ring
            ctx.lineWidth = 1.2 / zoom
            ctx.stroke()
          }
        } else {
          ctx.lineWidth = 1.2 / zoom
          ctx.strokeStyle = colors.nodeStroke
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
    }

    function drawLabels(focusIndex, focusSet, matched) {
      var radius = nodeRadius()
      var showAll = nodes.length <= 80 || zoom >= 0.8
      var rects = []
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i]
        var point = positions[i]
        if (!point) continue
        var isFocus = i === focusIndex
        var isSelected = selectedId != null && node.id === selectedId
        var isMatch = !!query && matched[i]
        var inFocus = focusIndex < 0 || focusSet.has(i)
        var filteredOut = typeFilter && typeFilter !== 'all' && (node.type || 'concept') !== typeFilter
        var queryOut = !!query && !matched[i]
        var dimmed = (focusIndex >= 0 && !inFocus) || queryOut || filteredOut
        if (!isFocus && !isSelected && !isMatch && (!showAll || dimmed)) continue

        var label = node.name
        if (!label) continue
        if (label.length > 22) label = label.slice(0, 21) + '…'
        var weight = isFocus || isSelected || isMatch ? '600 ' : ''
        ctx.font = weight + (11 / zoom) + 'px "PingFang SC","Segoe UI","Microsoft YaHei",sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        var textWidth = ctx.measureText(label).width
        var labelWidth = textWidth + 8 / zoom
        var labelHeight = 15 / zoom
        var labelX = point.x - labelWidth / 2
        var labelY = point.y + radius + 4 / zoom
        var overlaps = false
        for (var r = 0; r < rects.length; r++) {
          var rect = rects[r]
          if (labelX < rect.x + rect.w && labelX + labelWidth > rect.x &&
              labelY < rect.y + rect.h && labelY + labelHeight > rect.y) {
            overlaps = true
            break
          }
        }
        if (overlaps) continue
        rects.push({ x: labelX, y: labelY, w: labelWidth, h: labelHeight })

        ctx.globalAlpha = dimmed ? 0.3 : 1
        ctx.fillStyle = isSelected || isMatch ? colors.ring : colors.label
        ctx.shadowColor = colors.bg
        ctx.shadowBlur = 4 / zoom
        ctx.fillText(label, point.x, labelY + labelHeight / 2)
        ctx.shadowBlur = 0
        ctx.globalAlpha = 1
      }
      ctx.textBaseline = 'alphabetic'
    }

    // ================= 小地图 =================
    function minimapPosition() {
      return {
        x: MINIMAP_MARGIN,
        y: Math.max(MINIMAP_MARGIN, size.h - MINIMAP_H - MINIMAP_MARGIN)
      }
    }

    function minimapWorld() {
      return minimapMode === 'eagle' ? viewportWorld() : graphBounds()
    }

    function minimapGeometry() {
      var origin = minimapPosition()
      var world = minimapWorld()
      var worldW = world.maxX - world.minX || 1
      var worldH = world.maxY - world.minY || 1
      var scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH)
      var offsetX = origin.x + (MINIMAP_W - worldW * scale) / 2
      var offsetY = origin.y + (MINIMAP_H - worldH * scale) / 2
      return { origin: origin, world: world, scale: scale, offsetX: offsetX, offsetY: offsetY }
    }

    function drawMinimap() {
      if (!nodes.length) return
      if (size.w < 480 || size.h < 300) return
      var geometry = minimapGeometry()
      var origin = geometry.origin
      var world = geometry.world
      var scale = geometry.scale
      var offsetX = geometry.offsetX
      var offsetY = geometry.offsetY

      ctx.fillStyle = colors.minimapBg
      ctx.fillRect(origin.x, origin.y, MINIMAP_W, MINIMAP_H)
      ctx.strokeStyle = colors.minimapBorder
      ctx.lineWidth = 1
      ctx.strokeRect(origin.x + 0.5, origin.y + 0.5, MINIMAP_W - 1, MINIMAP_H - 1)

      for (var i = 0; i < nodes.length; i++) {
        var point = positions[i]
        if (!point) continue
        if (point.x < world.minX || point.x > world.maxX || point.y < world.minY || point.y > world.maxY) continue
        ctx.fillStyle = colors.type[nodes[i].type] || colors.type.unknown
        ctx.fillRect(
          offsetX + (point.x - world.minX) * scale - 1,
          offsetY + (point.y - world.minY) * scale - 1,
          2,
          2
        )
      }

      if (minimapMode === 'standard') {
        var view = viewportWorld()
        ctx.strokeStyle = colors.minimapViewport
        ctx.lineWidth = 1
        ctx.strokeRect(
          offsetX + (view.minX - world.minX) * scale,
          offsetY + (view.minY - world.minY) * scale,
          (view.maxX - view.minX) * scale,
          (view.maxY - view.minY) * scale
        )
      } else {
        var bounds = graphBounds()
        ctx.strokeStyle = colors.minimapBorder
        ctx.lineWidth = 1
        ctx.strokeRect(
          offsetX + (bounds.minX - world.minX) * scale,
          offsetY + (bounds.minY - world.minY) * scale,
          (bounds.maxX - bounds.minX) * scale,
          (bounds.maxY - bounds.minY) * scale
        )
      }
    }

    function minimapHit(screenX, screenY) {
      if (size.w < 480 || size.h < 300) return false
      var origin = minimapPosition()
      return screenX >= origin.x && screenX <= origin.x + MINIMAP_W &&
        screenY >= origin.y && screenY <= origin.y + MINIMAP_H
    }

    function minimapJump(screenX, screenY) {
      if (!nodes.length) return
      var geometry = minimapGeometry()
      var worldX = geometry.world.minX + (screenX - geometry.offsetX) / geometry.scale
      var worldY = geometry.world.minY + (screenY - geometry.offsetY) / geometry.scale
      centerOn({ x: worldX, y: worldY })
    }

    // ================= 指针交互 =================
    function updateHover(screenX, screenY) {
      var world = screenToWorld(screenX, screenY)
      var hit = hitTest(world.x, world.y)
      if (hit !== hoverIndex) {
        hoverIndex = hit
        markDirty()
      }
      if (!dragIndex && !viewDragging) {
        canvas.style.cursor = hit >= 0 ? 'pointer' : 'grab'
      }
    }

    function endPointer(event) {
      if (event && activePointerId != null) {
        try { canvas.releasePointerCapture(activePointerId) } catch (error) { /* 忽略 */ }
      }
      var wasDraggingNode = dragIndex >= 0
      dragIndex = -1
      viewDragging = false
      activePointerId = null
      canvas.classList.remove('is-dragging', 'is-node-dragging')
      if (wasDraggingNode && !reduceMotion) {
        startAnimation(PHYSICS.resumeTicks)
      } else {
        markDirty()
      }
    }

    function handleTap(screenX, screenY) {
      if (minimapHit(screenX, screenY)) {
        minimapJump(screenX, screenY)
        return
      }
      var world = screenToWorld(screenX, screenY)
      var hit = hitTest(world.x, world.y)
      if (hit >= 0) {
        selectedId = nodes[hit].id
        selectedEdgeId = null
        markDirty()
        onSelect(nodes[hit].id)
      } else {
        selectedId = null
        selectedEdgeId = null
        markDirty()
        onSelect(null)
      }
    }

    function onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      var point = eventPosition(event)
      lastPointer = point
      downPointer = point
      pointerMoved = false
      activePointerId = event.pointerId
      try { canvas.setPointerCapture(event.pointerId) } catch (error) { /* 忽略 */ }

      var world = screenToWorld(point.x, point.y)
      var hit = hitTest(world.x, world.y)
      if (hit >= 0) {
        dragIndex = hit
        animationOn = false
        canvas.classList.add('is-node-dragging')
        canvas.style.cursor = 'move'
      } else {
        viewDragging = true
        canvas.classList.add('is-dragging')
        canvas.style.cursor = 'grabbing'
      }
    }

    function onPointerMove(event) {
      var point = eventPosition(event)
      if (activePointerId == null || event.pointerId !== activePointerId) {
        updateHover(point.x, point.y)
        return
      }
      var dx = point.x - lastPointer.x
      var dy = point.y - lastPointer.y
      if (Math.abs(point.x - downPointer.x) > 4 || Math.abs(point.y - downPointer.y) > 4) pointerMoved = true

      if (dragIndex >= 0) {
        var world = screenToWorld(point.x, point.y)
        positions[dragIndex].x = world.x
        positions[dragIndex].y = world.y
        velocities[dragIndex].x = 0
        velocities[dragIndex].y = 0
        hoverIndex = dragIndex
        markDirty()
      } else if (viewDragging) {
        panX += dx
        panY += dy
        markDirty()
      }
      lastPointer = point
    }

    function onPointerUp(event) {
      if (activePointerId == null || event.pointerId !== activePointerId) return
      var point = eventPosition(event)
      var shouldTap = !pointerMoved
      endPointer(event)
      if (shouldTap) handleTap(point.x, point.y)
    }

    function onPointerCancel(event) {
      if (activePointerId != null && event.pointerId !== activePointerId) return
      endPointer(event)
    }

    function onPointerLeave() {
      if (activePointerId == null) {
        hoverIndex = -1
        canvas.style.cursor = 'grab'
        markDirty()
      }
    }

    function onWheel(event) {
      event.preventDefault()
      var point = eventPosition(event)
      var factor = event.deltaY < 0 ? 1.15 : 0.87
      zoomAt(point.x, point.y, factor)
    }

    function onKeyDown(event) {
      if (event.key === '+' || event.key === '=') {
        zoomAt(size.w / 2, size.h / 2, 1.2)
        event.preventDefault()
      } else if (event.key === '-' || event.key === '_') {
        zoomAt(size.w / 2, size.h / 2, 0.84)
        event.preventDefault()
      } else if (event.key === 'Home' || event.key === '0') {
        api.home()
        event.preventDefault()
      } else if (event.key === 'ArrowLeft') {
        panX += 60; markDirty(); event.preventDefault()
      } else if (event.key === 'ArrowRight') {
        panX -= 60; markDirty(); event.preventDefault()
      } else if (event.key === 'ArrowUp') {
        panY += 60; markDirty(); event.preventDefault()
      } else if (event.key === 'ArrowDown') {
        panY -= 60; markDirty(); event.preventDefault()
      }
    }

    // ================= 生命周期 =================
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault() })

    var resizeObserver = null
    if (global.ResizeObserver) {
      resizeObserver = new ResizeObserver(function () { markDirty() })
      resizeObserver.observe(stage)
    }
    global.addEventListener('resize', markDirty)

    // ================= 对外 API =================
    var api = {
      setData: setData,

      setSelected: function (id) {
        selectedId = id == null ? null : String(id)
        markDirty()
      },

      /** 高亮一条边（关系详情选中时使用）；传 null 清除。 */
      setSelectedEdge: function (id) {
        selectedEdgeId = id == null ? null : String(id)
        markDirty()
      },

      setSearch: function (text) {
        query = String(text == null ? '' : text).trim().toLowerCase()
        markDirty()
      },

      setTypeFilter: function (type) {
        typeFilter = type || 'all'
        markDirty()
      },

      focusNode: function (id) {
        var index = byId.get(String(id))
        if (index == null) return
        var targetZoom = Math.max(zoom, 0.9)
        centerOn(positions[index], targetZoom)
      },

      zoomIn: function () { zoomAt(size.w / 2, size.h / 2, 1.25) },
      zoomOut: function () { zoomAt(size.w / 2, size.h / 2, 0.8) },

      home: function () {
        zoom = 1
        panX = 0
        panY = 0
        markDirty()
      },

      fit: function () {
        if (!nodes.length) {
          api.home()
          return
        }
        var bounds = graphBounds()
        var padding = 76
        var spanX = Math.max(1, bounds.maxX - bounds.minX)
        var spanY = Math.max(1, bounds.maxY - bounds.minY)
        zoom = clamp(Math.min((size.w - padding * 2) / spanX, (size.h - padding * 2) / spanY), 0.2, 2.2)
        panX = size.w / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom
        panY = size.h / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom
        markDirty()
      },

      toggleMinimap: function () {
        minimapMode = minimapMode === 'standard' ? 'eagle' : 'standard'
        markDirty()
        return minimapMode
      },

      getMinimapMode: function () { return minimapMode },

      refreshTheme: function () {
        readColors()
        markDirty()
      },

      getCounts: function () {
        return { nodes: nodes.length, edges: edges.length, selectedId: selectedId }
      },

      resize: markDirty,

      destroy: function () {
        destroyed = true
        if (frameId) global.cancelAnimationFrame(frameId)
        if (resizeObserver) resizeObserver.disconnect()
        global.removeEventListener('resize', markDirty)
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerCancel)
        canvas.removeEventListener('pointerleave', onPointerLeave)
        canvas.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('keydown', onKeyDown)
      }
    }

    readColors()
    markDirty()
    return api
  }

  global.TXGraph = { create: create }
})(window)
