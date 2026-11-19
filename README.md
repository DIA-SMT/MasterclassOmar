# Nube de palabras · Masterclass "Sistemas sin fronteras"

App para la masterclass del **Ing. José Omar Abraham** (Ciclo de Masterclasses ISI Conecta · UTN FRT, 19/11).
Se proyecta una pregunta con un QR; la gente lo escanea, responde desde el celular y las respuestas forman una nube de palabras en vivo.

| Ruta | Para quién | Qué hace |
|---|---|---|
| `/` | Público (QR) | Ve la pregunta activa y manda respuestas (las que quiera). |
| `/pantalla` | Proyector | Bienvenida con QR → pregunta + nube en vivo + QR + contadores. |
| `/admin` | Operador | Carga preguntas, elige cuál se proyecta, abre/cierra respuestas, modera. |

**Stack:** Vite (HTML + JS, sin framework) · Supabase (Postgres + Realtime + Auth) · Vercel.

---

## 1. Supabase (≈5 min)

1. Crear un proyecto en [supabase.com](https://supabase.com) (plan Free alcanza).
2. **SQL Editor → New query** → pegar todo [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Authentication → Users → Add user → Create new user**: email + contraseña, tildar **Auto Confirm User**.
4. En el SQL Editor, habilitar ese email como admin:
   ```sql
   insert into public.admins (email) values ('tu-email@ejemplo.com') on conflict do nothing;
   ```
5. (Recomendado) **Authentication → Sign In / Providers → Email**: desactivar **Allow new users to sign up**.
   Aunque alguien se registre, no tendría permisos (solo los emails de `admins`), pero así queda cerrado.
6. **Project Settings → API**: copiar **Project URL** y la **anon public key** (o la *publishable key* `sb_publishable_…`).

## 2. Correr local

```powershell
Copy-Item .env.example .env.local   # completar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Abrir `http://localhost:5173/admin`, `http://localhost:5173/pantalla` y `http://localhost:5173/`.
Para probar desde el celular en la misma red: `npm run dev` muestra la URL de red (`http://192.168.x.x:5173`); abrí `/pantalla` con esa URL para que el QR apunte ahí.

## 3. Deploy en Vercel

**Opción A: GitHub + panel de Vercel**
1. Subir el repo a GitHub.
2. Vercel → **Add New → Project** → importar el repo (detecta Vite solo).
3. **Environment Variables**: `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
4. **Deploy**. El QR usa automáticamente el dominio de Vercel.

**Opción B: CLI**
```powershell
npx vercel
```
```powershell
npx vercel env add VITE_SUPABASE_URL
```
```powershell
npx vercel env add VITE_SUPABASE_ANON_KEY
```
```powershell
npx vercel --prod
```

> Si se cambian las variables de entorno hay que **volver a deployar**: Vite las incrusta al compilar.
> Opcional: `VITE_PUBLIC_URL` fuerza la URL del QR (por ejemplo, un dominio propio).

---

## Cómo se usa el día del evento

**Antes (desde `/admin`):**
- Cargar las preguntas (se pueden reordenar con ↑ ↓ y editar).
- Abrir `/pantalla` en la compu del proyector → tecla **F** (o el botón) para pantalla completa.
- Escanear el QR desde el fondo del aula para confirmar que se lee bien.

**Durante:**
1. Sin pregunta activa, la pantalla muestra la **bienvenida con el QR grande**.
2. **Proyectar** una pregunta → los celulares la reciben solos (no hace falta recargar).
3. **Mostrar QR grande**: QR a pantalla completa encima de la nube, útil al arrancar cada pregunta.
4. **Cerrar respuestas** congela la nube; **Siguiente pregunta →** pasa a la próxima.
5. **Moderación**: **Ocultar** saca una palabra de la nube al instante. Las **Filtradas** las frenó el filtro automático (malas palabras, links, teléfonos); si son válidas, **Permitir**.
6. **Exportar respuestas (CSV)** al final (abre directo en Excel).

### Reglas de las respuestas
- Hasta **25 caracteres** por respuesta (palabra o frase corta). Cada persona puede mandar **todas las que quiera**.
- Una misma palabra cuenta **una sola vez por persona** (así nadie infla una palabra mandándola 50 veces).
- Se agrupan variantes: `Innovación`, `innovacion!!` e `INNOVACIÓN` cuentan como la misma; se muestra la forma más usada.
- Anti-spam suave: como máximo un envío cada ~0,8 s por celular.

---

## Notas técnicas

- **Tiempo real:** celulares y proyector escuchan `app_state` por Supabase Realtime. Si Realtime no conecta (el plan Free admite ~200 conexiones simultáneas), cada celular cae solo a *polling* cada 5 s, así que nadie se queda afuera. La nube del proyector se actualiza cada 1,5 s.
- **Seguridad (RLS):** el público no puede leer ni escribir tablas: solo usa las funciones `get_current`, `submit_answer` y `get_cloud`. Todo lo de `/admin` exige un usuario de Supabase Auth cuyo email esté en `public.admins`.
- **Filtro:** `blocked_words` (ampliable desde el panel). Detecta variantes como `PUTOOO`, `p0t0`, `p u t o` y `hijodeputa` sin marcar palabras como `computadora` o `minúsculo`. Las palabras nuevas que bloquees se aplican a las respuestas que lleguen después; lo que ya está en pantalla se saca con **Ocultar**.
- **Estética:** colores, tipografías (Montserrat + Lexend) y logos tomados del banner del evento. Los logos de `public/logos/` se recortaron de la captura del banner; si tenés los originales en alta resolución, reemplazá esos PNG (mismo nombre, fondo transparente).
- **Textos del evento:** `src/config.js` y el HTML de cada vista.

```
├─ index.html            → vista celular
├─ pantalla.html         → proyector
├─ admin.html            → panel
├─ src/
│  ├─ participante.js · pantalla.js · admin.js
│  ├─ lib/cloud.js       → layout + animación de la nube
│  ├─ lib/supabase.js    → cliente, id de dispositivo, Realtime con fallback
│  ├─ lib/decor.js       → QR, red de nodos, motivo de circuito
│  └─ styles/            → base (tokens del banner) + una hoja por vista
├─ public/logos/         → logos recortados del banner
└─ supabase/schema.sql   → tablas, RLS, funciones, filtro, Realtime
```
