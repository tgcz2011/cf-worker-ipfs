/**
 * 修正说明：
 * 1. 新增 API 路径调试日志（输出实际请求的 URL）
 * 2. 修正请求头的 Content-Type 为 application/octet-stream（Cloudflare 要求）
 * 3. 新增 Token 权限校验逻辑（通过预请求验证）
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML_TEMPLATE, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      return this.handleUpload(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/images') {
      return this.handleListImages(env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async handleUpload(request, env) {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return new Response(JSON.stringify({ error: '未上传文件' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      // 调试：输出实际请求的 API URL
      const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ipfs/pins`;
      console.log('[DEBUG] IPFS API URL:', apiUrl);

      // 验证 Account ID 格式（16 位十六进制字符）
      if (!/^[0-9a-f]{32}$/i.test(env.CF_ACCOUNT_ID)) {
        throw new Error('CF_ACCOUNT_ID 格式错误（应为 32 位十六进制字符串）');
      }

      // 预检查 Token 权限（可选调试步骤）
      const authTest = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` }
      });
      if (!authTest.ok) {
        const tokenError = await authTest.json();
        throw new Error(`API Token 验证失败: ${tokenError.errors?.[0]?.message || '权限不足'}`);
      }

      // 上传文件到 IPFS（修正 Content-Type 为 application/octet-stream）
      const ipfsResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/octet-stream', // 强制使用二进制流类型
          'X-Api-User': 'worker-ipfs-gallery'         // 可选：标识请求来源
        },
        body: file // 直接传递文件内容（二进制流）
      });

      const ipfsData = await ipfsResponse.json();
      if (!ipfsResponse.ok) {
        const errorMsg = ipfsData.errors?.[0]?.message || JSON.stringify(ipfsData);
        throw new Error(`IPFS 接口错误: ${errorMsg}`);
      }

      const cid = ipfsData.result.cid;
      const fileName = file.name;
      const timestamp = Date.now();

      await env.IPFS_GALLERY.put(cid, JSON.stringify({
        cid,
        fileName,
        timestamp,
        size: file.size,
        mimeType: file.type,
        ipfsUrl: `https://${cid}.ipfs.cf-ipfs.com`
      }));

      return new Response(JSON.stringify({
        success: true,
        cid,
        ipfsUrl: `https://${cid}.ipfs.cf-ipfs.com`,
        fileName
      }), {
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async handleListImages(env) {
    const { keys } = await env.IPFS_GALLERY.list();
    const images = [];
    
    for (const key of keys) {
      const imageData = await env.IPFS_GALLERY.get(key.name);
      images.push(JSON.parse(imageData));
    }

    images.sort((a, b) => b.timestamp - a.timestamp);
    return new Response(JSON.stringify(images), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPFS 图床 - Cloudflare Worker</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .drop-zone { border: 2px dashed #e5e7eb; transition: all 0.3s; }
    .drop-zone.active { border-color: #3b82f6; background: #f3f4f6; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="container mx-auto p-4 max-w-3xl">
    <h1 class="text-2xl font-bold text-gray-900 mb-8 text-center">IPFS 图床</h1>

    <div class="bg-white rounded-lg shadow-md p-6 mb-8">
      <div class="drop-zone p-8 text-center">
        <p class="text-gray-600 mb-4">拖动文件到此处上传，或点击选择文件</p>
        <input type="file" accept="image/*" id="fileInput" class="hidden">
        <button id="selectBtn" class="bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 transition-colors">
          选择图片
        </button>
      </div>
      <div id="uploadStatus" class="mt-4 text-sm text-red-500"></div>
    </div>

    <div class="bg-white rounded-lg shadow-md p-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-4">已上传图片</h2>
      <div id="imageList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
    </div>
  </div>
</body>
</html>
    `  <script>
    // DOM 元素引用
    const dropZone = document.querySelector('.drop-zone');
    const fileInput = document.getElementById('fileInput');
    const selectBtn = document.getElementById('selectBtn');
    const uploadStatus = document.getElementById('uploadStatus');
    const imageList = document.getElementById('imageList');

    // 初始化加载图片列表
    loadImages();

    // 拖拽事件处理
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(eventName) {
      dropZone.addEventListener(eventName, preventDefaults);
      document.body.addEventListener(eventName, preventDefaults);
    });

    ['dragenter', 'dragover'].forEach(function(eventName) {
      dropZone.addEventListener(eventName, function() {
        dropZone.classList.add('active');
      });
    });

    ['dragleave', 'drop'].forEach(function(eventName) {
      dropZone.addEventListener(eventName, function() {
        dropZone.classList.remove('active');
      });
    });

    // 按钮点击事件：触发文件选择框
    selectBtn.addEventListener('click', function() {
      fileInput.click();
    });

    // 文件选择事件
    fileInput.addEventListener('change', handleFileSelect);
    // 拖拽释放事件
    dropZone.addEventListener('drop', handleDrop);

    // 处理拖拽文件
    function handleDrop(e) {
      var files = e.dataTransfer.files;
      if (files.length > 0) uploadFiles(files);
    }

    // 处理选择文件
    function handleFileSelect(e) {
      var files = e.target.files;
      if (files.length > 0) uploadFiles(files);
    }

    // 上传文件逻辑
    async function uploadFiles(files) {
      var file = files[0];
      uploadStatus.textContent = '正在上传：' + file.name + '...';
      
      try {
        var formData = new FormData();
        formData.append('file', file);
        
        var response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });
        
        var result = await response.json();
        if (result.success) {
          uploadStatus.textContent = '上传成功！IPFS 链接：' + result.ipfsUrl;
          uploadStatus.classList.remove('text-red-500');
          uploadStatus.classList.add('text-green-500');
          loadImages(); // 刷新列表
        } else {
          uploadStatus.textContent = '上传失败：' + result.error;
          uploadStatus.classList.add('text-red-500');
        }
      } catch (error) {
        uploadStatus.textContent = '上传错误：' + error.message;
        uploadStatus.classList.add('text-red-500');
      }
    }

    // 加载图片列表
    async function loadImages() {
      try {
        var response = await fetch('/images');
        var images = await response.json();
        
        var html = '';
        images.forEach(function(img) {
          html += '<div class="border rounded p-3 shadow-sm">' +
                  '  <div class="text-sm text-gray-600 mb-2">' + img.fileName + ' · ' + new Date(img.timestamp).toLocaleString() + '</div>' +
                  '  <img src="' + img.ipfsUrl + '" alt="' + img.fileName + '" class="w-full h-48 object-cover rounded-sm bg-gray-100">' +
                  '  <div class="mt-2 flex gap-2">' +
                  '    <input type="text" value="' + img.ipfsUrl + '" class="flex-1 p-1 border rounded text-sm" readonly>' +
                  '    <button class="px-2 py-1 bg-blue-500 text-white text-sm rounded hover:bg-blue-600 transition-colors" onclick="copyText(this.previousElementSibling)">复制链接</button>' +
                  '  </div>' +
                  '</div>';
        });
        imageList.innerHTML = html;
      } catch (error) {
        imageList.innerHTML = '<div class="text-red-500">加载图片失败：' + error.message + '</div>';
      }
    }

    // 复制链接到剪贴板
    function copyText(input) {
      input.select();
      document.execCommand('copy');
      alert('链接已复制到剪贴板');
    }

    // 阻止默认拖拽行为
    function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
    }
  </script>
</body>
</html>
    `
