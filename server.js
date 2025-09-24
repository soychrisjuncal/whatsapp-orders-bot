require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configuración de Twilio WhatsApp
const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN ? 
  twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : 
  null;

// Configuración de Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Store temporal para carritos de usuarios
const userCarts = new Map();
const userStates = new Map();

// Estados del bot
const STATES = {
  MAIN_MENU: 'main_menu',
  DELIVERY_INFO: 'delivery_info',
  CONFIRMING_ORDER: 'confirming_order'
};

// Función para obtener el menú de Google Sheets
async function getMenu() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Menu!A:F',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];
    
    const [headers, ...data] = rows;
    return data.map(row => ({
      id: row[0],
      name: row[1],
      description: row[2] || '',
      price: parseFloat(row[3]),
      category: row[4],
      available: row[5] === 'TRUE'
    })).filter(item => item.available);
  } catch (error) {
    console.error('Error getting menu:', error);
    return [];
  }
}

// Función para guardar pedido en Google Sheets
async function saveOrder(orderData) {
  try {
    const values = [[
      new Date().toISOString(),
      orderData.customerPhone,
      orderData.customerName,
      JSON.stringify(orderData.items),
      orderData.total,
      orderData.deliveryType,
      orderData.address || '',
      'NUEVO'
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Pedidos!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });
  } catch (error) {
    console.error('Error saving order:', error);
  }
}

// Función para formatear el menú
function formatMenu(menu) {
  const categories = [...new Set(menu.map(item => item.category))];
  let message = "🍽️ *MENÚ DISPONIBLE*\n\n";
  
  categories.forEach(category => {
    message += `📋 *${category}*\n`;
    menu.filter(item => item.category === category).forEach(item => {
      message += `${item.id}. ${item.name} - $${item.price}\n`;
      if (item.description) {
        message += `   _${item.description}_\n`;
      }
    });
    message += "\n";
  });
  
  message += "Para ordenar, envía el número del producto.\n";
  message += "Para ver tu carrito: *carrito*\n";
  message += "Para finalizar pedido: *finalizar*";
  
  return message;
}

// Función para formatear el carrito
function formatCart(cart) {
  if (!cart || cart.length === 0) {
    return "🛒 Tu carrito está vacío.\nEnvía *menu* para ver nuestros productos.";
  }
  
  let message = "🛒 *TU CARRITO*\n\n";
  let total = 0;
  
  cart.forEach(item => {
    const subtotal = item.price * item.quantity;
    total += subtotal;
    message += `${item.name}\n`;
    message += `Cantidad: ${item.quantity} x $${item.price} = $${subtotal.toFixed(2)}\n\n`;
  });
  
  message += `*TOTAL: $${total.toFixed(2)}*\n\n`;
  message += "Opciones:\n";
  message += "• *menu* - Ver menú\n";
  message += "• *limpiar* - Vaciar carrito\n";
  message += "• *finalizar* - Completar pedido";
  
  return message;
}

// Función para enviar mensajes
async function sendMessage(to, body) {
  if (!client) {
    console.error('Twilio client not initialized - check credentials');
    return;
  }
  try {
    await client.messages.create({
      body: body,
      from: 'whatsapp:+14155238886',
      to: to
    });
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Función para procesar pedido completo
async function processOrder(phone, customerName, cart, deliveryType, address = '') {
  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  
  const orderData = {
    customerPhone: phone,
    customerName: customerName,
    items: cart,
    total: total,
    deliveryType: deliveryType,
    address: address
  };
  
  await saveOrder(orderData);
  
  // Limpiar carrito y estado
  userCarts.set(phone, []);
  userStates.set(phone, STATES.MAIN_MENU);
  
  // Mensaje de confirmación
  let confirmMessage = "✅ *PEDIDO CONFIRMADO*\n\n";
  confirmMessage += `📝 *Resumen:*\n`;
  
  cart.forEach(item => {
    confirmMessage += `• ${item.name} x${item.quantity} - $${(item.price * item.quantity).toFixed(2)}\n`;
  });
  
  confirmMessage += `\n💰 *Total: $${total.toFixed(2)}*\n\n`;
  
  if (deliveryType === 'delivery') {
    confirmMessage += `🚚 *Delivery a:* ${address}\n`;
    confirmMessage += `⏱️ *Tiempo estimado:* 30-45 minutos\n\n`;
  } else {
    confirmMessage += `🏪 *Retiro en local*\n`;
    confirmMessage += `⏱️ *Estará listo en:* 20-30 minutos\n\n`;
  }
  
  confirmMessage += "¡Gracias por tu pedido! 😊";
  
  await sendMessage(phone, confirmMessage);
}

// Webhook principal de WhatsApp
app.post('/webhook', async (req, res) => {
  const { Body, From, ProfileName } = req.body;
  const message = Body.toLowerCase().trim();
  const phone = From;
  const customerName = ProfileName || 'Cliente';
  
  console.log(`Mensaje de ${phone}: ${message}`);
  
  // Obtener estado actual del usuario
  let userState = userStates.get(phone) || STATES.MAIN_MENU;
  let cart = userCarts.get(phone) || [];
  
  try {
    if (message === 'menu' || message === 'menú') {
      const menu = await getMenu();
      const menuText = formatMenu(menu);
      await sendMessage(phone, menuText);
      userStates.set(phone, STATES.MAIN_MENU);
      
    } else if (message === 'carrito') {
      const cartText = formatCart(cart);
      await sendMessage(phone, cartText);
      
    } else if (message === 'limpiar') {
      userCarts.set(phone, []);
      await sendMessage(phone, "🗑️ Carrito vaciado. Envía *menu* para comenzar.");
      userStates.set(phone, STATES.MAIN_MENU);
      
    } else if (message === 'finalizar') {
      if (cart.length === 0) {
        await sendMessage(phone, "Tu carrito está vacío. Envía *menu* para agregar productos.");
        return res.sendStatus(200);
      }
      
      let confirmMessage = "🏠 *TIPO DE ENTREGA*\n\n";
      confirmMessage += "1. 🚚 Delivery\n";
      confirmMessage += "2. 🏪 Retiro en local\n\n";
      confirmMessage += "Responde con el número de tu elección.";
      
      await sendMessage(phone, confirmMessage);
      userStates.set(phone, STATES.DELIVERY_INFO);
      
    } else if (userState === STATES.DELIVERY_INFO) {
      if (message === '1') {
        await sendMessage(phone, "📍 Por favor envía tu dirección completa para el delivery:");
        userStates.set(phone, STATES.CONFIRMING_ORDER);
        
      } else if (message === '2') {
        await processOrder(phone, customerName, cart, 'pickup');
        
      } else {
        await sendMessage(phone, "Por favor selecciona una opción válida:\n1. Delivery\n2. Retiro en local");
      }
      
    } else if (userState === STATES.CONFIRMING_ORDER) {
      await processOrder(phone, customerName, cart, 'delivery', message);
      
    } else if (/^\d+$/.test(message)) {
      // Usuario seleccionó un producto por número
      const menu = await getMenu();
      const productId = parseInt(message);
      const product = menu.find(item => parseInt(item.id) === productId);
      
      if (product) {
        // Agregar al carrito
        const existingItem = cart.find(item => item.id === product.id);
        
        if (existingItem) {
          existingItem.quantity += 1;
        } else {
          cart.push({
            ...product,
            quantity: 1
          });
        }
        
        userCarts.set(phone, cart);
        
        await sendMessage(phone, 
          `✅ *${product.name}* agregado al carrito.\n\n` +
          `Cantidad: ${existingItem ? existingItem.quantity : 1}\n` +
          `Precio: $${product.price}\n\n` +
          `Envía otro número para agregar más productos.\n` +
          `*carrito* - Ver carrito\n` +
          `*finalizar* - Completar pedido`
        );
        
      } else {
        await sendMessage(phone, "❌ Producto no encontrado. Envía *menu* para ver opciones disponibles.");
      }
      
    } else {
      // Mensaje de bienvenida
      const welcomeMessage = 
        `¡Hola ${customerName}! 👋\n\n` +
        `Bienvenido a nuestro sistema de pedidos.\n\n` +
        `Envía *menu* para ver nuestros productos disponibles.`;
      
      await sendMessage(phone, welcomeMessage);
      userStates.set(phone, STATES.MAIN_MENU);
    }
    
  } catch (error) {
    console.error('Error processing message:', error);
    await sendMessage(phone, "❌ Hubo un error. Por favor intenta nuevamente.");
  }
  
  res.sendStatus(200);
});

// Ruta para el panel de administración
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API para obtener pedidos
app.get('/api/orders', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Pedidos!A:H',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return res.json([]);
    }
    
    const [headers, ...data] = rows;
    const orders = data.map(row => ({
      date: row[0],
      phone: row[1],
      customer: row[2],
      items: JSON.parse(row[3] || '[]'),
      total: parseFloat(row[4]),
      deliveryType: row[5],
      address: row[6],
      status: row[7]
    }));
    
    res.json(orders);
  } catch (error) {
    console.error('Error getting orders:', error);
    res.status(500).json({ error: 'Error getting orders' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 WhatsApp Order Bot running on port ${PORT}`);
  console.log(`📱 Panel: http://localhost:${PORT}`);
});