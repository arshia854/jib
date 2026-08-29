import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { updateAsset, deleteAsset, AssetNotFoundError, type UpdateAssetInput } from "@/lib/data/assets";
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_ASSET_QUANTITY, MAX_ASSET_PRICE_PER_UNIT } from "@/lib/limits";
import { reportError } from "@/lib/observability/report-error";
import { ERROR_TYPES } from "@/lib/observability/error-types";
import { isPrismaErrorCode } from "@/lib/observability/classify-error";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const data: UpdateAssetInput = {};

  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: "نام دارایی بیش از حد طولانی است." }, { status: 400 });
    }
    data.name = name || null;
  }

  if (body?.quantity !== undefined && body?.quantity !== null) {
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_ASSET_QUANTITY) {
      return NextResponse.json({ error: "مقدار دارایی نامعتبر است." }, { status: 400 });
    }
    data.quantity = quantity;
  }

  if (body?.purchasePricePerUnit !== undefined && body?.purchasePricePerUnit !== null) {
    const purchasePricePerUnit = Number(body.purchasePricePerUnit);
    if (!Number.isFinite(purchasePricePerUnit) || purchasePricePerUnit <= 0 || purchasePricePerUnit > MAX_ASSET_PRICE_PER_UNIT) {
      return NextResponse.json({ error: "قیمت خرید نامعتبر است." }, { status: 400 });
    }
    data.purchasePricePerUnit = purchasePricePerUnit;
  }

  if (body?.purchaseDate !== undefined && body?.purchaseDate !== null) {
    const purchaseDate = new Date(body.purchaseDate);
    if (Number.isNaN(purchaseDate.getTime())) {
      return NextResponse.json({ error: "تاریخ خرید نامعتبر است." }, { status: 400 });
    }
    data.purchaseDate = purchaseDate;
  }

  if (body?.currentPricePerUnit !== undefined && body?.currentPricePerUnit !== null) {
    const currentPricePerUnit = Number(body.currentPricePerUnit);
    if (!Number.isFinite(currentPricePerUnit) || currentPricePerUnit <= 0 || currentPricePerUnit > MAX_ASSET_PRICE_PER_UNIT) {
      return NextResponse.json({ error: "ارزش فعلی نامعتبر است." }, { status: 400 });
    }
    data.currentPricePerUnit = currentPricePerUnit;
  }

  if (typeof body?.note === "string") {
    if (body.note.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json({ error: "یادداشت بیش از حد طولانی است." }, { status: 400 });
    }
    data.note = body.note.trim() || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای بروزرسانی ارسال نشد." }, { status: 400 });
  }

  try {
    const asset = await updateAsset(session.userId, assetId, data);
    return NextResponse.json({ asset });
  } catch (error) {
    if (error instanceof AssetNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - AssetNotFoundError above is an
    // already-handled, expected outcome and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "assets/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error updating asset",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "updateAsset", model: "Asset", code: error.code }
        : { operation: "updateAsset", model: "Asset" },
    });
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "ابتدا وارد شوید." }, { status: 401 });
  }

  const { id } = await params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId)) {
    return NextResponse.json({ error: "شناسه نامعتبر است." }, { status: 400 });
  }

  try {
    await deleteAsset(session.userId, assetId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AssetNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Unhandled/unexpected only - AssetNotFoundError above is an
    // already-handled, expected outcome and isn't reported here.
    reportError({
      errorType: isPrismaErrorCode(error) ? ERROR_TYPES.DB_ERROR : ERROR_TYPES.API_ERROR,
      route: "assets/[id]",
      userId: session.userId,
      message: error instanceof Error ? error.message : "Unexpected error deleting asset",
      error,
      context: isPrismaErrorCode(error)
        ? { operation: "deleteAsset", model: "Asset", code: error.code }
        : { operation: "deleteAsset", model: "Asset" },
    });
    throw error;
  }
}
