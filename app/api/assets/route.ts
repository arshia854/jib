import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listAssetsWithValue, createAsset } from "@/lib/data/assets";
import { ASSET_TYPES } from "@/lib/assets";
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_ASSET_QUANTITY, MAX_ASSET_PRICE_PER_UNIT } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const summary = await listAssetsWithValue(session.userId);
  return NextResponse.json(summary);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  const type = typeof body?.type === "string" ? body.type : "";
  if (!ASSET_TYPES.some((t) => t.value === type)) {
    return NextResponse.json({ error: "نوع دارایی نامعتبر است." }, { status: 400 });
  }

  const quantity = Number(body?.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_ASSET_QUANTITY) {
    return NextResponse.json({ error: "مقدار دارایی نامعتبر است." }, { status: 400 });
  }

  const purchasePricePerUnit = Number(body?.purchasePricePerUnit);
  if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0 || purchasePricePerUnit > MAX_ASSET_PRICE_PER_UNIT) {
    return NextResponse.json({ error: "قیمت خرید نامعتبر است." }, { status: 400 });
  }

  let purchaseDate: Date | undefined;
  if (body?.purchaseDate !== undefined && body?.purchaseDate !== null) {
    const parsed = new Date(body.purchaseDate);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "تاریخ خرید نامعتبر است." }, { status: 400 });
    }
    purchaseDate = parsed;
  }

  const isCustom = type === "custom";
  let name: string | null = null;
  if (isCustom) {
    name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: "برای دارایی دستی، نام الزامی است." }, { status: 400 });
    }
  }

  let currentPricePerUnit: number | undefined;
  if (isCustom && body?.currentPricePerUnit !== undefined && body?.currentPricePerUnit !== null) {
    const value = Number(body.currentPricePerUnit);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_ASSET_PRICE_PER_UNIT) {
      return NextResponse.json({ error: "ارزش فعلی نامعتبر است." }, { status: 400 });
    }
    currentPricePerUnit = value;
  }

  let note: string | null | undefined;
  if (typeof body?.note === "string") {
    if (body.note.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: "یادداشت بیش از حد طولانی است." }, { status: 400 });
    }
    note = body.note.trim() || null;
  }

  try {
    const asset = await createAsset(session.userId, {
      type,
      name,
      quantity,
      purchasePricePerUnit,
      purchaseDate,
      currentPricePerUnit,
      note,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "assets",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error creating asset",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "createAsset", model: "Asset", code: error.code }
        : { operation: "createAsset", model: "Asset" },
    });
    throw error;
  }
}
