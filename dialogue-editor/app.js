    (function () {
      const STORAGE_KEY = 'dialogue-tree-editor-v2';
      const UI_KEY = 'dialogue-tree-editor-ui-v3';
      const ZOOM_MIN = 0.1;
      const ZOOM_MAX = 2.5;
      const ZOOM_STEP = 1.1;

      const layout = document.getElementById('layout');
      const canvas = document.getElementById('canvas');
      const workspace = document.getElementById('workspace');
      const workspaceContent = document.getElementById('workspace-content');
      const graphStage = document.getElementById('graph-stage');
      const connectionsSvg = document.getElementById('connections');
      const statusEl = document.getElementById('status');
      const countsEl = document.getElementById('counts');
      const importFileInput = document.getElementById('import-file');
      const toggleSidebarBtn = document.getElementById('toggle-sidebar');
      const contextMenuEl = document.getElementById('context-menu');

      const state = {
        nodes: [],
        pendingConnection: null,
        drag: null,
        pointer: { x: 0, y: 0 },
        zoom: 1,
        camera: { x: 80, y: 80 },
        pan: null,
        contextMenu: { x: 140, y: 140, clientX: 24, clientY: 24, open: false },
        sidebarCollapsed: false
      };

      function uid(prefix) {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return prefix + '_' + window.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        }
        return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      }

      function dialogueTemplate(x, y) {
        return {
          id: uid('node'),
          type: 'dialogue',
          x,
          y,
          title: 'New dialogue node',
          response: {
            mode: 'text',
            content: ''
          },
          outputLabelInstruction: '',
          outputs: [
            {
              id: uid('out'),
              label: 'default',
              targetNodeId: null
            }
          ]
        };
      }

      function endTemplate(x, y) {
        return {
          id: uid('node'),
          type: 'end',
          x,
          y,
          title: 'End conversation',
          endText: ''
        };
      }

      function makeStarterState() {
        const start = dialogueTemplate(0, 0);
        start.title = 'Start';
        start.response.content = 'Welcome! How can I help?';
        start.outputs = [
          { id: uid('out'), label: 'ask question', targetNodeId: null },
          { id: uid('out'), label: 'goodbye', targetNodeId: null }
        ];
        return [start, endTemplate(480, 80)];
      }

      function setStatus(message, tone) {
        statusEl.textContent = message;
        statusEl.className = 'status';
        if (tone) {
          statusEl.classList.add(tone);
        }
      }

      const storage = (() => {
        try {
          const testKey = '__dialogue_tree_editor_test__';
          window.localStorage.setItem(testKey, '1');
          window.localStorage.removeItem(testKey);
          return window.localStorage;
        } catch (error) {
          console.warn('localStorage unavailable; autosave disabled.', error);
          return null;
        }
      })();

      function storageGet(key) {
        if (!storage) return null;
        try {
          return storage.getItem(key);
        } catch (error) {
          console.warn('Could not read stored state', error);
          return null;
        }
      }

      function storageSet(key, value) {
        if (!storage) return false;
        try {
          storage.setItem(key, value);
          return true;
        } catch (error) {
          console.warn('Could not save stored state', error);
          return false;
        }
      }

      function saveToLocalStorage() {
        storageSet(STORAGE_KEY, JSON.stringify(serializeState()));
        storageSet(UI_KEY, JSON.stringify({
          sidebarCollapsed: state.sidebarCollapsed,
          zoom: state.zoom,
          cameraX: state.camera.x,
          cameraY: state.camera.y
        }));
      }

      function serializeState() {
        return {
          version: 2,
          nodes: state.nodes.map((node) => {
            if (node.type === 'dialogue') {
              return {
                id: node.id,
                type: node.type,
                position: { x: node.x, y: node.y },
                title: node.title,
                response: {
                  mode: node.response.mode,
                  content: node.response.content
                },
                outputLabelInstruction: String(node.outputLabelInstruction || ''),
                outputs: node.outputs.map((output) => ({
                  id: output.id,
                  label: output.label,
                  target: output.targetNodeId
                }))
              };
            }
            return {
              id: node.id,
              type: node.type,
              position: { x: node.x, y: node.y },
              title: node.title,
              endText: node.endText || ''
            };
          })
        };
      }

      function normalizeImportedData(data) {
        if (!data || !Array.isArray(data.nodes)) {
          throw new Error('JSON must contain a nodes array.');
        }

        const nodes = data.nodes.map((rawNode, index) => {
          const x = Number(rawNode.x ?? rawNode.position?.x ?? 80 + index * 40);
          const y = Number(rawNode.y ?? rawNode.position?.y ?? 80 + index * 40);
          const type = rawNode.type === 'end' ? 'end' : 'dialogue';
          const id = String(rawNode.id || uid('node'));
          const title = String(rawNode.title || (type === 'end' ? 'End conversation' : 'Dialogue node'));

          if (type === 'end') {
            return {
              id,
              type: 'end',
              x,
              y,
              title,
              endText: String(rawNode.endText || rawNode.response?.content || '')
            };
          }

          const responseMode = rawNode.response?.mode === 'ai' || rawNode.responseType === 'ai' ? 'ai' : 'text';
          const responseContent = String(rawNode.response?.content ?? rawNode.responseText ?? rawNode.botResponse ?? '');
          const outputsRaw = Array.isArray(rawNode.outputs) ? rawNode.outputs : [];

          return {
            id,
            type: 'dialogue',
            x,
            y,
            title,
            response: {
              mode: responseMode,
              content: responseContent
            },
            outputLabelInstruction: String(rawNode.outputLabelInstruction || rawNode.outputCategoryInstruction || ''),
            outputs: outputsRaw.map((rawOutput, outputIndex) => ({
              id: String(rawOutput.id || uid('out') + '_' + outputIndex),
              label: String(rawOutput.label || rawOutput.category || 'category'),
              targetNodeId: rawOutput.targetNodeId ?? rawOutput.target ?? null
            }))
          };
        });

        if (nodes.length === 0) {
          throw new Error('The imported nodes array is empty.');
        }

        return nodes;
      }

      function findNode(nodeId) {
        return state.nodes.find((node) => node.id === nodeId);
      }

      function getNodeTitle(nodeId) {
        const node = findNode(nodeId);
        return node ? (node.title || node.type) : 'Missing node';
      }

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function createField(labelText) {
        const field = document.createElement('div');
        field.className = 'field';
        const label = document.createElement('label');
        label.textContent = labelText;
        field.appendChild(label);
        return field;
      }

      function clientToGraph(clientX, clientY) {
        const workspaceRect = workspace.getBoundingClientRect();
        return {
          x: (clientX - workspaceRect.left - state.camera.x) / state.zoom,
          y: (clientY - workspaceRect.top - state.camera.y) / state.zoom
        };
      }

      function getHandleCenter(element) {
        const handleRect = element.getBoundingClientRect();
        const workspaceRect = workspace.getBoundingClientRect();
        return {
          x: (handleRect.left - workspaceRect.left - state.camera.x + handleRect.width / 2) / state.zoom,
          y: (handleRect.top - workspaceRect.top - state.camera.y + handleRect.height / 2) / state.zoom
        };
      }

      function makePath(start, end) {
        const curve = Math.max(70, Math.abs(end.x - start.x) * 0.45);
        return 'M ' + start.x + ' ' + start.y + ' C ' + (start.x + curve) + ' ' + start.y + ', ' + (end.x - curve) + ' ' + end.y + ', ' + end.x + ' ' + end.y;
      }

      function updateLayoutState() {
        layout.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
        toggleSidebarBtn.textContent = state.sidebarCollapsed ? '⇥' : '⇤';
        toggleSidebarBtn.title = state.sidebarCollapsed ? 'Expand help' : 'Collapse help';
      }

      function updateWorkspaceTransform() {
        graphStage.style.transform = 'translate(' + state.camera.x + 'px, ' + state.camera.y + 'px) scale(' + state.zoom + ')';
      }

      function updateConnectionViewport(points) {
        if (!points.length) {
          connectionsSvg.style.left = '0px';
          connectionsSvg.style.top = '0px';
          connectionsSvg.style.width = '1px';
          connectionsSvg.style.height = '1px';
          connectionsSvg.setAttribute('viewBox', '0 0 1 1');
          connectionsSvg.setAttribute('width', '1');
          connectionsSvg.setAttribute('height', '1');
          return;
        }

        const padding = 220;
        const minX = Math.min.apply(null, points.map((point) => point.x)) - padding;
        const minY = Math.min.apply(null, points.map((point) => point.y)) - padding;
        const maxX = Math.max.apply(null, points.map((point) => point.x)) + padding;
        const maxY = Math.max.apply(null, points.map((point) => point.y)) + padding;
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);

        connectionsSvg.style.left = minX + 'px';
        connectionsSvg.style.top = minY + 'px';
        connectionsSvg.style.width = width + 'px';
        connectionsSvg.style.height = height + 'px';
        connectionsSvg.setAttribute('viewBox', minX + ' ' + minY + ' ' + width + ' ' + height);
        connectionsSvg.setAttribute('width', String(width));
        connectionsSvg.setAttribute('height', String(height));
      }

      function getViewportCenterGraph() {
        return {
          x: (workspace.clientWidth / 2 - state.camera.x) / state.zoom,
          y: (workspace.clientHeight / 2 - state.camera.y) / state.zoom
        };
      }

      function updateCounts() {
        countsEl.textContent = state.nodes.length + ' node' + (state.nodes.length === 1 ? '' : 's') + ' · ' + Math.round(state.zoom * 100) + '% zoom';
      }

      function renderConnections() {
        connectionsSvg.innerHTML = '';
        const points = [];

        state.nodes.forEach((node) => {
          if (node.type !== 'dialogue') return;
          node.outputs.forEach((output) => {
            if (!output.targetNodeId) return;

            const startHandle = canvas.querySelector('.output-port[data-node-id="' + CSS.escape(node.id) + '"][data-output-id="' + CSS.escape(output.id) + '"]');
            const endHandle = canvas.querySelector('.input-port[data-node-id="' + CSS.escape(output.targetNodeId) + '"]');
            if (!startHandle || !endHandle) return;

            const start = getHandleCenter(startHandle);
            const end = getHandleCenter(endHandle);
            points.push(start, end);

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('class', 'connection-path');
            path.setAttribute('d', makePath(start, end));
            connectionsSvg.appendChild(path);
          });
        });

        if (state.pendingConnection) {
          const fromHandle = canvas.querySelector('.output-port[data-node-id="' + CSS.escape(state.pendingConnection.nodeId) + '"][data-output-id="' + CSS.escape(state.pendingConnection.outputId) + '"]');
          if (fromHandle) {
            const start = getHandleCenter(fromHandle);
            points.push(start, state.pointer);

            const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            preview.setAttribute('class', 'connection-preview');
            preview.setAttribute('d', makePath(start, state.pointer));
            connectionsSvg.appendChild(preview);
          }
        }

        updateConnectionViewport(points);
      }

      function renderAll() {
        updateLayoutState();
        updateWorkspaceTransform();
        canvas.innerHTML = '';

        state.nodes.forEach((node) => {
          const nodeEl = document.createElement('div');
          nodeEl.className = 'node ' + node.type;
          nodeEl.style.left = node.x + 'px';
          nodeEl.style.top = node.y + 'px';
          nodeEl.dataset.nodeId = node.id;

          const inputPort = document.createElement('button');
          inputPort.className = 'port input-port' + (state.pendingConnection ? ' can-connect' : '');
          inputPort.title = 'Input';
          inputPort.type = 'button';
          inputPort.dataset.nodeId = node.id;
          inputPort.addEventListener('click', function (event) {
            event.stopPropagation();
            if (!state.pendingConnection) {
              setStatus('Select an output exit first, then click this input.', 'alert');
              return;
            }
            completeConnection(node.id);
          });
          nodeEl.appendChild(inputPort);

          const header = document.createElement('div');
          header.className = 'node-header';
          header.innerHTML = '\n            <div class="node-kind">\n              <span class="dot"></span>\n              <span>' + (node.type === 'dialogue' ? 'Dialogue node' : 'End node') + '</span>\n            </div>\n          ';

          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'icon-btn';
          deleteBtn.title = 'Delete node';
          deleteBtn.textContent = '✕';
          deleteBtn.addEventListener('click', function (event) {
            event.stopPropagation();
            deleteNode(node.id);
          });
          header.appendChild(deleteBtn);
          header.addEventListener('mousedown', function (event) {
            if (event.button !== 0) return;
            startDrag(event, node.id);
          });
          nodeEl.appendChild(header);

          const titleField = createField('Title');
          const titleInput = document.createElement('input');
          titleInput.type = 'text';
          titleInput.value = node.title || '';
          titleInput.placeholder = node.type === 'dialogue' ? 'Node title' : 'End node title';
          titleInput.addEventListener('input', function (event) {
            node.title = event.target.value;
            saveToLocalStorage();
            renderConnections();
          });
          titleField.appendChild(titleInput);
          nodeEl.appendChild(titleField);

          if (node.type === 'dialogue') {
            const responseModeField = createField('Bot response mode');
            const modeSelect = document.createElement('select');
            modeSelect.innerHTML = '\n              <option value="text">Text</option>\n              <option value="ai">AI answer</option>\n            ';
            modeSelect.value = node.response.mode;
            modeSelect.addEventListener('change', function (event) {
              node.response.mode = event.target.value;
              saveToLocalStorage();
              renderAll();
            });
            responseModeField.appendChild(modeSelect);

            const modeNote = document.createElement('div');
            modeNote.className = 'inline-note';
            modeNote.textContent = node.response.mode === 'text'
              ? 'This exact text is returned to the user.'
              : 'Use this field to describe what the AI should answer here.';
            responseModeField.appendChild(modeNote);
            nodeEl.appendChild(responseModeField);

            const responseField = createField(node.response.mode === 'text' ? 'Bot response text' : 'AI answer instruction');
            const responseTextarea = document.createElement('textarea');
            responseTextarea.value = node.response.content;
            responseTextarea.placeholder = node.response.mode === 'text'
              ? 'Type the exact bot response here...'
              : 'Optional instruction for the AI, for example tone or goal...';
            responseTextarea.addEventListener('input', function (event) {
              node.response.content = event.target.value;
              saveToLocalStorage();
            });
            responseField.appendChild(responseTextarea);
            nodeEl.appendChild(responseField);

            const outputsWrap = document.createElement('div');
            outputsWrap.className = 'outputs';

            const outputsHead = document.createElement('div');
            outputsHead.className = 'outputs-head';
            outputsHead.innerHTML = '<strong>Output categories</strong>';
            outputsWrap.appendChild(outputsHead);

            const outputInstructionInput = document.createElement('input');
            outputInstructionInput.type = 'text';
            outputInstructionInput.className = 'output-instruction-input';
            outputInstructionInput.value = node.outputLabelInstruction || '';
            outputInstructionInput.placeholder = 'Optional: how AI should choose category labels';
            outputInstructionInput.setAttribute('aria-label', 'Output category label instruction');
            outputInstructionInput.addEventListener('input', function (event) {
              node.outputLabelInstruction = event.target.value;
              saveToLocalStorage();
            });
            outputsWrap.appendChild(outputInstructionInput);

            const outputsList = document.createElement('div');
            outputsList.className = 'outputs-list';

            if (!node.outputs.length) {
              const empty = document.createElement('p');
              empty.className = 'empty-note';
              empty.textContent = 'No output categories yet.';
              outputsList.appendChild(empty);
            }

            node.outputs.forEach((output) => {
              const row = document.createElement('div');
              row.className = 'output-row';
              row.dataset.outputId = output.id;

              const inner = document.createElement('div');
              inner.className = 'output-row-inner';

              const labelInput = document.createElement('input');
              labelInput.type = 'text';
              labelInput.className = 'output-label-input';
              labelInput.value = output.label;
              labelInput.placeholder = 'Category label';
              labelInput.addEventListener('input', function (event) {
                output.label = event.target.value;
                saveToLocalStorage();
              });
              inner.appendChild(labelInput);

              const unlinkBtn = document.createElement('button');
              unlinkBtn.type = 'button';
              unlinkBtn.className = 'mini-btn unlink';
              unlinkBtn.title = 'Clear connection';
              unlinkBtn.textContent = '⤼';
              unlinkBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                output.targetNodeId = null;
                if (state.pendingConnection && state.pendingConnection.outputId === output.id) {
                  state.pendingConnection = null;
                }
                saveToLocalStorage();
                renderAll();
                setStatus('Connection cleared.', 'success');
              });
              inner.appendChild(unlinkBtn);

              const deleteOutputBtn = document.createElement('button');
              deleteOutputBtn.type = 'button';
              deleteOutputBtn.className = 'mini-btn delete';
              deleteOutputBtn.title = 'Delete output category';
              deleteOutputBtn.textContent = '✕';
              deleteOutputBtn.addEventListener('click', function (event) {
                event.stopPropagation();
                removeOutput(node.id, output.id);
              });
              inner.appendChild(deleteOutputBtn);

              row.appendChild(inner);

              if (output.targetNodeId) {
                const pill = document.createElement('div');
                pill.className = 'target-pill';
                pill.innerHTML = '<span>Linked to:</span> <span class="node-title-preview">' + escapeHtml(getNodeTitle(output.targetNodeId)) + '</span>';
                row.appendChild(pill);
              }

              const outputPort = document.createElement('button');
              outputPort.type = 'button';
              outputPort.className = 'port output-port' + (
                state.pendingConnection &&
                state.pendingConnection.nodeId === node.id &&
                state.pendingConnection.outputId === output.id
                  ? ' active'
                  : ''
              );
              outputPort.title = 'Connect this category';
              outputPort.dataset.nodeId = node.id;
              outputPort.dataset.outputId = output.id;
              outputPort.addEventListener('click', function (event) {
                event.stopPropagation();
                beginConnection(node.id, output.id);
              });
              row.appendChild(outputPort);

              outputsList.appendChild(row);
            });

            outputsWrap.appendChild(outputsList);

            const addOutputBtn = document.createElement('button');
            addOutputBtn.type = 'button';
            addOutputBtn.className = 'add-output';
            addOutputBtn.textContent = '+ Add output category';
            addOutputBtn.addEventListener('click', function (event) {
              event.stopPropagation();
              node.outputs.push({
                id: uid('out'),
                label: 'new category',
                targetNodeId: null
              });
              saveToLocalStorage();
              renderAll();
            });
            outputsWrap.appendChild(addOutputBtn);
            nodeEl.appendChild(outputsWrap);
          } else {
            const endField = createField('Optional ending text');
            const endTextarea = document.createElement('textarea');
            endTextarea.value = node.endText || '';
            endTextarea.placeholder = 'Optional final message before the conversation ends...';
            endTextarea.addEventListener('input', function (event) {
              node.endText = event.target.value;
              saveToLocalStorage();
            });
            endField.appendChild(endTextarea);
            nodeEl.appendChild(endField);

            const note = document.createElement('div');
            note.className = 'footer-note';
            note.textContent = 'This node has no outputs and ends the dialogue.';
            nodeEl.appendChild(note);
          }

          canvas.appendChild(nodeEl);
        });

        updateCounts();
        renderConnections();
      }

      function beginConnection(nodeId, outputId) {
        hideContextMenu();
        const current = state.pendingConnection;
        if (current && current.nodeId === nodeId && current.outputId === outputId) {
          state.pendingConnection = null;
          renderAll();
          setStatus('Connection mode cancelled.');
          return;
        }

        state.pendingConnection = { nodeId, outputId };
        renderAll();
        setStatus('Now click the input at the top of another node to connect this category.', 'success');
      }

      function completeConnection(targetNodeId) {
        const pending = state.pendingConnection;
        if (!pending) return;

        const sourceNode = findNode(pending.nodeId);
        if (!sourceNode || sourceNode.type !== 'dialogue') {
          state.pendingConnection = null;
          renderAll();
          return;
        }

        const output = sourceNode.outputs.find((item) => item.id === pending.outputId);
        if (!output) {
          state.pendingConnection = null;
          renderAll();
          return;
        }

        output.targetNodeId = targetNodeId;
        state.pendingConnection = null;
        saveToLocalStorage();
        renderAll();
        setStatus('Connected to “' + getNodeTitle(targetNodeId) + '”.', 'success');
      }

      function removeOutput(nodeId, outputId) {
        const node = findNode(nodeId);
        if (!node || node.type !== 'dialogue') return;
        node.outputs = node.outputs.filter((output) => output.id !== outputId);
        if (state.pendingConnection && state.pendingConnection.outputId === outputId) {
          state.pendingConnection = null;
        }
        saveToLocalStorage();
        renderAll();
        setStatus('Output category removed.', 'success');
      }

      function deleteNode(nodeId) {
        state.nodes = state.nodes.filter((node) => node.id !== nodeId);
        state.nodes.forEach((node) => {
          if (node.type !== 'dialogue') return;
          node.outputs.forEach((output) => {
            if (output.targetNodeId === nodeId) {
              output.targetNodeId = null;
            }
          });
        });
        if (state.pendingConnection && state.pendingConnection.nodeId === nodeId) {
          state.pendingConnection = null;
        }
        if (state.nodes.length === 0) {
          state.nodes = makeStarterState();
          setStatus('The board was empty, so a starter layout was restored.', 'success');
        } else {
          setStatus('Node deleted.', 'success');
        }
        saveToLocalStorage();
        renderAll();
      }

      function addDialogueNodeAt(x, y) {
        state.nodes.push(dialogueTemplate(x, y));
        saveToLocalStorage();
        renderAll();
        setStatus('Dialogue node added.', 'success');
      }

      function addEndNodeAt(x, y) {
        state.nodes.push(endTemplate(x, y));
        saveToLocalStorage();
        renderAll();
        setStatus('End node added.', 'success');
      }

      function addDialogueNode() {
        const center = getViewportCenterGraph();
        addDialogueNodeAt(center.x - 140, center.y - 80);
      }

      function addEndNode() {
        const center = getViewportCenterGraph();
        addEndNodeAt(center.x - 140, center.y - 80);
      }

      function startDrag(event, nodeId) {
        hideContextMenu();
        const node = findNode(nodeId);
        if (!node || state.pan) return;
        const point = clientToGraph(event.clientX, event.clientY);
        state.drag = {
          nodeId,
          offsetX: point.x - node.x,
          offsetY: point.y - node.y
        };
      }

      function startPan(event) {
        if (event.button !== 1) return;
        hideContextMenu();
        event.preventDefault();
        state.pan = {
          startClientX: event.clientX,
          startClientY: event.clientY,
          startCameraX: state.camera.x,
          startCameraY: state.camera.y
        };
        workspace.classList.add('panning');
      }

      function onPointerMove(event) {
        state.pointer = clientToGraph(event.clientX, event.clientY);

        if (state.pan) {
          state.camera.x = state.pan.startCameraX + (event.clientX - state.pan.startClientX);
          state.camera.y = state.pan.startCameraY + (event.clientY - state.pan.startClientY);
          updateWorkspaceTransform();
          state.pointer = clientToGraph(event.clientX, event.clientY);
          renderConnections();
          return;
        }

        if (!state.drag) {
          if (state.pendingConnection) {
            renderConnections();
          }
          return;
        }

        const node = findNode(state.drag.nodeId);
        if (!node) return;

        node.x = state.pointer.x - state.drag.offsetX;
        node.y = state.pointer.y - state.drag.offsetY;

        const nodeEl = canvas.querySelector('.node[data-node-id="' + CSS.escape(node.id) + '"]');
        if (nodeEl) {
          nodeEl.style.left = node.x + 'px';
          nodeEl.style.top = node.y + 'px';
        }

        renderConnections();
      }

      function onPointerUp() {
        if (state.drag) {
          state.drag = null;
          saveToLocalStorage();
        }
        if (state.pan) {
          state.pan = null;
          workspace.classList.remove('panning');
          saveToLocalStorage();
        }
      }

      function setZoom(nextZoom, clientX, clientY) {
        const newZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
        if (Math.abs(newZoom - state.zoom) < 0.0001) return;

        const workspaceRect = workspace.getBoundingClientRect();
        const anchorX = clientX - workspaceRect.left;
        const anchorY = clientY - workspaceRect.top;
        const graphX = (anchorX - state.camera.x) / state.zoom;
        const graphY = (anchorY - state.camera.y) / state.zoom;

        state.zoom = newZoom;
        state.camera.x = anchorX - graphX * state.zoom;
        state.camera.y = anchorY - graphY * state.zoom;
        updateWorkspaceTransform();
        updateCounts();
        renderConnections();
        saveToLocalStorage();
      }

      function exportJson() {
        const json = JSON.stringify(serializeState(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const link = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        link.href = URL.createObjectURL(blob);
        link.download = 'dialogue-tree-' + stamp + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        setStatus('JSON exported.', 'success');
      }

      function importJsonFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
          try {
            const parsed = JSON.parse(String(reader.result || '{}'));
            state.nodes = normalizeImportedData(parsed);
            state.pendingConnection = null;
            hideContextMenu();
            saveToLocalStorage();
            renderAll();
            setStatus('JSON imported successfully.', 'success');
          } catch (error) {
            console.error(error);
            setStatus(error.message || 'Could not import that JSON file.', 'alert');
          }
        };
        reader.readAsText(file);
      }

      function resetBoard() {
        const confirmed = window.confirm('Reset the board to a starter layout? This clears the current diagram from the editor.');
        if (!confirmed) return;
        state.nodes = makeStarterState();
        state.pendingConnection = null;
        hideContextMenu();
        saveToLocalStorage();
        renderAll();
        setStatus('Board reset.', 'success');
      }

      function positionContextMenu(clientX, clientY) {
        const shellRect = contextMenuEl.parentElement.getBoundingClientRect();
        const menuWidth = 190;
        const menuHeight = 108;
        const left = clamp(clientX - shellRect.left, 8, Math.max(8, shellRect.width - menuWidth - 8));
        const top = clamp(clientY - shellRect.top, 8, Math.max(8, shellRect.height - menuHeight - 8));
        contextMenuEl.style.left = left + 'px';
        contextMenuEl.style.top = top + 'px';
      }

      function showContextMenu(clientX, clientY, graphX, graphY) {
        state.contextMenu = { x: graphX, y: graphY, clientX, clientY, open: true };
        positionContextMenu(clientX, clientY);
        contextMenuEl.classList.remove('hidden');
      }

      function hideContextMenu() {
        state.contextMenu.open = false;
        contextMenuEl.classList.add('hidden');
      }

      function hydrate() {
        const saved = storageGet(STORAGE_KEY);
        if (!saved) {
          state.nodes = makeStarterState();
        } else {
          try {
            state.nodes = normalizeImportedData(JSON.parse(saved));
          } catch (error) {
            console.warn('Could not read saved state, using starter layout instead.', error);
            state.nodes = makeStarterState();
          }
        }

        try {
          const savedUi = JSON.parse(storageGet(UI_KEY) || '{}');
          state.sidebarCollapsed = Boolean(savedUi.sidebarCollapsed);
          state.zoom = clamp(Number(savedUi.zoom) || 1, ZOOM_MIN, ZOOM_MAX);
          state.camera.x = Number.isFinite(Number(savedUi.cameraX)) ? Number(savedUi.cameraX) : 80;
          state.camera.y = Number.isFinite(Number(savedUi.cameraY)) ? Number(savedUi.cameraY) : 80;
        } catch (error) {
          state.sidebarCollapsed = false;
          state.zoom = 1;
          state.camera.x = 80;
          state.camera.y = 80;
        }

        renderAll();
      }

      document.getElementById('add-dialogue').addEventListener('click', addDialogueNode);
      document.getElementById('add-end').addEventListener('click', addEndNode);
      document.getElementById('export-json').addEventListener('click', exportJson);
      document.getElementById('import-json').addEventListener('click', function () {
        importFileInput.click();
      });
      document.getElementById('reset-board').addEventListener('click', resetBoard);
      document.getElementById('menu-add-dialogue').addEventListener('click', function (event) {
        event.stopPropagation();
        addDialogueNodeAt(state.contextMenu.x, state.contextMenu.y);
        hideContextMenu();
      });
      document.getElementById('menu-add-end').addEventListener('click', function (event) {
        event.stopPropagation();
        addEndNodeAt(state.contextMenu.x, state.contextMenu.y);
        hideContextMenu();
      });
      toggleSidebarBtn.addEventListener('click', function () {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        updateLayoutState();
        saveToLocalStorage();
      });

      importFileInput.addEventListener('change', function (event) {
        importJsonFile(event.target.files && event.target.files[0]);
        event.target.value = '';
      });

      workspace.addEventListener('mousemove', onPointerMove);
      workspace.addEventListener('mousedown', function (event) {
        if (event.button === 1) {
          startPan(event);
        }
      });
      workspace.addEventListener('auxclick', function (event) {
        if (event.button === 1) {
          event.preventDefault();
        }
      });
      window.addEventListener('mouseup', onPointerUp);
      window.addEventListener('resize', function () {
        if (state.contextMenu.open) {
          positionContextMenu(state.contextMenu.clientX, state.contextMenu.clientY);
        }
        renderConnections();
      });

      workspace.addEventListener('wheel', function (event) {
        const interactiveTarget = event.target.closest('textarea, input, select');
        if (interactiveTarget) {
          return;
        }
        event.preventDefault();
        hideContextMenu();
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        setZoom(state.zoom * factor, event.clientX, event.clientY);
      }, { passive: false });

      workspace.addEventListener('contextmenu', function (event) {
        const blocked = event.target.closest('input, textarea, select');
        if (blocked) {
          return;
        }
        event.preventDefault();
        if (state.pendingConnection) {
          state.pendingConnection = null;
          renderAll();
        }
        const graphPoint = clientToGraph(event.clientX, event.clientY);
        showContextMenu(event.clientX, event.clientY, graphPoint.x, graphPoint.y);
        setStatus('Choose a node type to add it at the cursor.', 'success');
      });

      workspace.addEventListener('click', function (event) {
        const clickedMenu = event.target.closest('#context-menu');
        if (!clickedMenu) {
          hideContextMenu();
        }
        if (event.target === workspace || event.target === workspaceContent || event.target === graphStage || event.target === canvas || event.target === connectionsSvg) {
          if (state.pendingConnection) {
            state.pendingConnection = null;
            renderAll();
            setStatus('Connection mode cancelled.');
          }
        }
      });

      document.addEventListener('click', function (event) {
        if (!event.target.closest('#context-menu')) {
          hideContextMenu();
        }
      });

      hydrate();
    })();
  
